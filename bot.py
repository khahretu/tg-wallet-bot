import logging, io, asyncio, shortuuid, humanize
from datetime import datetime, timedelta
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, MessageHandler, filters, ContextTypes
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
import config
from database import init_db, get_db, User, ShortLink, UploadedFile
from cdn_storage import upload_to_cdn, delete_from_cdn
import magic
from androguard.misc import AnalyzeAPK

logging.basicConfig(level=logging.INFO)

def generate_slug(custom=None):
    if custom and len(custom) > 3:
        return custom.replace(" ", "-").lower()
    return shortuuid.uuid()[:8]

async def get_or_create_user(db: AsyncSession, tg_id: int):
    result = await db.execute(select(User).where(User.telegram_id == tg_id))
    user = result.scalar_one_or_none()
    if not user:
        user = User(telegram_id=tg_id)
        db.add(user)
        await db.commit()
        await db.refresh(user)
    return user

# --- Handlers ---
async def start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "🚀 **Feature-packed Bot**\n"
        "/short <url> [slug] [expiry_min] – Create short link\n"
        "/mass – Bulk shortener (send 5-10 URLs)\n"
        "/myfiles – Manage uploaded files\n"
        "/search <name> – Search in your files\n"
        "Send any file → uploaded to CDN + APK metadata extraction\n"
        "Landing pages with ads & safe badge enabled.",
        parse_mode="Markdown"
    )

async def shortlink_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    args = ctx.args
    if not args:
        await update.message.reply_text("Usage: /short <url> [custom_slug] [expiry_minutes]")
        return
    url = args[0]
    custom_slug = args[1] if len(args) > 1 else None
    expiry_min = int(args[2]) if len(args) > 2 and args[2].isdigit() else None
    async for db in get_db():
        user = await get_or_create_user(db, update.effective_user.id)
        slug = generate_slug(custom_slug)
        existing = await db.execute(select(ShortLink).where(ShortLink.slug == slug))
        if existing.scalar_one_or_none():
            await update.message.reply_text("Slug already taken. Try another.")
            return
        expiry = datetime.utcnow() + timedelta(minutes=expiry_min) if expiry_min else None
        link = ShortLink(
            user_id=user.id, slug=slug, original_url=url,
            domain=config.DEFAULT_DOMAIN, expiry_time=expiry
        )
        db.add(link)
        await db.commit()
        short_url = f"https://{config.DEFAULT_DOMAIN}/{slug}"
        msg = f"✅ Short link created:\n{short_url}\n"
        if expiry:
            msg += f"⏰ Expires: {expiry.strftime('%Y-%m-%d %H:%M UTC')}"
        await update.message.reply_text(msg)

async def mass_shrink_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    urls = update.message.text.split("\n")[1:]
    if len(urls) < 2 or len(urls) > 10:
        await update.message.reply_text("Send 5-10 URLs, each on new line after /mass")
        return
    async for db in get_db():
        user = await get_or_create_user(db, update.effective_user.id)
        result = []
        for url in urls:
            slug = generate_slug()
            link = ShortLink(user_id=user.id, slug=slug, original_url=url, domain=config.DEFAULT_DOMAIN)
            db.add(link)
            result.append(f"https://{config.DEFAULT_DOMAIN}/{slug} -> {url[:50]}")
        await db.commit()
        await update.message.reply_text("Bulk short links:\n" + "\n".join(result[:10]))

async def myfiles_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    async for db in get_db():
        user = await get_or_create_user(db, update.effective_user.id)
        files = await db.execute(select(UploadedFile).where(UploadedFile.user_id == user.id).order_by(UploadedFile.created_at.desc()))
        files = files.scalars().all()
        if not files:
            await update.message.reply_text("📂 No files uploaded yet.\nSend me an APK or any file.")
            return
        total_mb = sum(f.size_mb for f in files)
        text = f"📁 Your files ({len(files)} items) | Total: {total_mb:.2f} MB\n\n"
        keyboard = []
        for f in files[:20]:
            keyboard.append([InlineKeyboardButton(f"{f.original_name} ({f.size_mb:.1f}MB)", callback_data=f"file_{f.id}")])
        await update.message.reply_text(text, reply_markup=InlineKeyboardMarkup(keyboard))

async def file_callback(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    if data.startswith("file_"):
        file_id = int(data.split("_")[1])
        async for db in get_db():
            file = await db.get(UploadedFile, file_id)
            if file:
                keyboard = [
                    [InlineKeyboardButton("🗑 Delete", callback_data=f"del_{file_id}")],
                    [InlineKeyboardButton("🔗 Get Link", callback_data=f"getlink_{file_id}")],
                ]
                await query.edit_message_text(f"*{file.original_name}*\nSize: {file.size_mb:.2f} MB\nCDN: ✅", parse_mode="Markdown", reply_markup=InlineKeyboardMarkup(keyboard))
    elif data.startswith("del_"):
        file_id = int(data.split("_")[1])
        async for db in get_db():
            file = await db.get(UploadedFile, file_id)
            if file:
                await delete_from_cdn(file.cdn_key)
                await db.delete(file)
                await db.commit()
                await query.edit_message_text("✅ File deleted from CDN and database.")
    elif data.startswith("getlink_"):
        file_id = int(data.split("_")[1])
        async for db in get_db():
            file = await db.get(UploadedFile, file_id)
            if file:
                await query.edit_message_text(f"🔗 Direct CDN link:\n`{file.cdn_url}`\n\nShort link not yet created. Use /short {file.cdn_url}", parse_mode="Markdown")

async def handle_document(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    doc = update.message.document
    if not doc:
        return
    file_size_mb = doc.file_size / (1024*1024)
    if file_size_mb > 500:
        await update.message.reply_text("File too large (>500MB).")
        return
    file_obj = await doc.get_file()
    file_data = io.BytesIO()
    await file_obj.download_to_memory(file_data)
    file_data.seek(0)
    mime = magic.from_buffer(file_data.read(1024), mime=True)
    file_data.seek(0)
    original_name = doc.file_name
    key = f"user_{update.effective_user.id}/{datetime.utcnow().timestamp()}_{original_name}"
    cdn_url = await upload_to_cdn(file_data, key, mime)
    async for db in get_db():
        user = await get_or_create_user(db, update.effective_user.id)
        apk_package = apk_version = apk_icon_url = None
        if original_name.endswith(".apk"):
            file_data.seek(0)
            try:
                apk, dex, dx = AnalyzeAPK(file_data)
                apk_package = apk.get_package()
                apk_version = apk.get_androidversion_name()
                apk_icon_url = "https://via.placeholder.com/80?text=APK"
            except:
                pass
        new_file = UploadedFile(
            user_id=user.id, filename=key, original_name=original_name,
            size_mb=file_size_mb, cdn_key=key, cdn_url=cdn_url,
            apk_package=apk_package, apk_version=apk_version, apk_icon_url=apk_icon_url
        )
        db.add(new_file)
        await db.commit()
        user.total_storage_mb += file_size_mb
        await db.commit()
    await update.message.reply_text(f"✅ File uploaded to CDN!\n🔗 Direct link: {cdn_url}\nUse /short to create a trackable short link.")

async def search_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not ctx.args:
        await update.message.reply_text("Usage: /search filename_part")
        return
    query_text = " ".join(ctx.args).lower()
    async for db in get_db():
        user = await get_or_create_user(db, update.effective_user.id)
        files = await db.execute(select(UploadedFile).where(UploadedFile.user_id == user.id))
        files = files.scalars().all()
        matches = [f for f in files if query_text in f.original_name.lower()]
        if not matches:
            await update.message.reply_text("No matching files.")
        else:
            text = "🔍 Found:\n" + "\n".join(f"{f.original_name} ({f.size_mb:.1f}MB)" for f in matches[:10])
            await update.message.reply_text(text)

def main():
    app = Application.builder().token(config.BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("short", shortlink_cmd))
    app.add_handler(CommandHandler("mass", mass_shrink_cmd))
    app.add_handler(CommandHandler("myfiles", myfiles_cmd))
    app.add_handler(CommandHandler("search", search_cmd))
    app.add_handler(CallbackQueryHandler(file_callback))
    app.add_handler(MessageHandler(filters.Document.ALL, handle_document))
    app.run_polling()

if __name__ == "__main__":
    asyncio.run(init_db())
    main()
