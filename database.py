from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy import Column, Integer, String, DateTime, Boolean, BigInteger, Float, Text
from datetime import datetime
import config

# Convert postgresql:// to postgresql+asyncpg://
async_db_url = config.DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://")
engine = create_async_engine(async_db_url, echo=False)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
Base = declarative_base()

# --- Models ---
class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    telegram_id = Column(BigInteger, unique=True)
    custom_domain = Column(String, nullable=True)
    total_storage_mb = Column(Float, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)

class ShortLink(Base):
    __tablename__ = "short_links"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer)
    slug = Column(String, unique=True)
    original_url = Column(Text)
    domain = Column(String)
    expiry_time = Column(DateTime, nullable=True)
    clicks = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)

class ClickAnalytics(Base):
    __tablename__ = "click_analytics"
    id = Column(Integer, primary_key=True)
    link_id = Column(Integer)
    country = Column(String)
    timestamp = Column(DateTime, default=datetime.utcnow)

class UploadedFile(Base):
    __tablename__ = "uploaded_files"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer)
    filename = Column(String)
    original_name = Column(String)
    size_mb = Column(Float)
    cdn_key = Column(String)
    cdn_url = Column(String)
    apk_package = Column(String, nullable=True)
    apk_version = Column(String, nullable=True)
    apk_icon_url = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

# --- Helper functions ---
async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session
