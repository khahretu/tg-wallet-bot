import boto3
from botocore.config import Config
import config
from typing import BinaryIO

s3_client = boto3.client(
    "s3",
    endpoint_url=config.R2_ENDPOINT_URL,
    aws_access_key_id=config.R2_ACCESS_KEY,
    aws_secret_access_key=config.R2_SECRET_KEY,
    config=Config(signature_version="s3v4"),
)

async def upload_to_cdn(file_data: BinaryIO, key: str, content_type: str) -> str:
    s3_client.upload_fileobj(
        file_data,
        config.R2_BUCKET_NAME,
        key,
        ExtraArgs={"ContentType": content_type},
    )
    return f"{config.CDN_PUBLIC_URL}/{key}"

async def delete_from_cdn(key: str):
    s3_client.delete_object(Bucket=config.R2_BUCKET_NAME, Key=key)
