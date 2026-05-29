import os
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
ADMIN_IDS = [int(id) for id in os.getenv("ADMIN_IDS", "").split(",") if id]

# CDN (Cloudflare R2 / S3)
R2_ACCESS_KEY = os.getenv("R2_ACCESS_KEY")
R2_SECRET_KEY = os.getenv("R2_SECRET_KEY")
R2_ENDPOINT_URL = os.getenv("R2_ENDPOINT_URL")
R2_BUCKET_NAME = os.getenv("R2_BUCKET_NAME")
CDN_PUBLIC_URL = os.getenv("CDN_PUBLIC_URL")

# Domains (comma separated)
PUBLIC_DOMAINS = [d.strip() for d in os.getenv("PUBLIC_DOMAINS", "").split(",") if d]
DEFAULT_DOMAIN = PUBLIC_DOMAINS[0] if PUBLIC_DOMAINS else "example.com"

# Database – Render provides DATABASE_URL
DATABASE_URL = os.getenv("DATABASE_URL")  # postgresql://...

# Adsense (optional)
ADSENSE_CLIENT = os.getenv("ADSENSE_CLIENT")
ADSENSE_SLOT = os.getenv("ADSENSE_SLOT")
