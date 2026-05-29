from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from database import AsyncSessionLocal, UploadedFile, ShortLink, ClickAnalytics
import config
from datetime import datetime

app = FastAPI()

@app.get("/{slug}", response_class=HTMLResponse)
async def landing_page(request: Request, slug: str):
    country = request.headers.get("CF-IPCountry", "Unknown")
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(ShortLink).where(ShortLink.slug == slug))
        link = result.scalar_one_or_none()
        if link:
            link.clicks += 1
            analytics = ClickAnalytics(link_id=link.id, country=country)
            db.add(analytics)
            await db.commit()
            if link.original_url.startswith(config.CDN_PUBLIC_URL):
                file_result = await db.execute(
                    select(UploadedFile).where(UploadedFile.cdn_url == link.original_url)
                )
                file = file_result.scalar_one_or_none()
                if file:
                    return HTMLResponse(content=render_apk_page(file, slug), status_code=200)
        if link and link.original_url:
            return HTMLResponse(content=f'<meta http-equiv="refresh" content="0;url={link.original_url}">', status_code=200)
        return HTMLResponse(content="<h1>Link not found</h1>", status_code=404)

def render_apk_page(file: UploadedFile, slug: str) -> str:
    download_url = f"{file.cdn_url}"
    ads_code = ""
    if config.ADSENSE_CLIENT:
        ads_code = f'''
        <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>
        <ins class="adsbygoogle"
             style="display:block"
             data-ad-client="{config.ADSENSE_CLIENT}"
             data-ad-slot="{config.ADSENSE_SLOT}"></ins>
        <script>(adsbygoogle = window.adsbygoogle || []).push({});</script>
        '''
    return f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Download {file.original_name}</title>
        <style>
            body {{ font-family: Arial; text-align: center; padding: 50px; }}
            .safe-badge {{ background: #4CAF50; color: white; padding: 5px 10px; border-radius: 20px; display: inline-block; }}
            .download-btn {{ background: #2196F3; color: white; padding: 15px 30px; font-size: 20px; border: none; border-radius: 5px; cursor: pointer; margin-top: 30px; text-decoration: none; display: inline-block; }}
            img.icon {{ width: 80px; height: 80px; border-radius: 20px; }}
        </style>
    </head>
    <body>
        <img class="icon" src="{file.apk_icon_url or 'https://via.placeholder.com/80'}" alt="icon">
        <h2>{file.original_name}</h2>
        <p>Version: {file.apk_version or 'Unknown'} | Size: {file.size_mb:.2f} MB</p>
        <div class="safe-badge">✓ SSL Secure | Verified Safe</div>
        {ads_code}
        <br><br>
        <a href="{download_url}" class="download-btn">⬇️ Download Now</a>
        <p style="color:gray;">Direct download – no captcha, no waiting</p>
    </body>
    </html>
    """
