# Daily order photos

Admins open `/order-photos` from the dashboard, the phone header camera shortcut,
the phone menu, or the installed PWA's app shortcut (where supported).
Choose the store and day, then take a photo or select up to 20 images. Upload begins
immediately. Each image can be up to 25 MiB. Keep the page open until each image
shows saved; failed uploads can be retried without creating duplicates.

Images are private. Both upload and viewing require admin authentication and the
selected store. The gallery supports previous days and pagination. JPEG, PNG,
WebP, AVIF, single-frame GIF and TIFF are decoded, oriented, stripped of metadata
and converted to WebP (quality 90); the long edge is capped at 5000 pixels.
A 600-pixel WebP thumbnail (quality 80) is encoded separately from the source.
The image picker accepts image files; actual decoder support is checked on upload.
Animated/multipage files, SVG and unsupported codecs are rejected with a clear
message. HEIC support depends on the server's decoder; camera capture or JPEG
export can be used when a phone's original HEIC cannot be decoded.
Phone capture uses the rear camera where supported. The mobile PWA needs an
HTTPS deployment to install and work remotely; the offline desktop trial's local
server is not a phone-accessible deployment.

## Storage

Development defaults to `server/data/photo-bucket`. The offline desktop trial uses
its persistent application-data `photo-bucket` directory.

For production choose one:

- Local durable volume: set `PHOTO_STORAGE_DRIVER=local` and set
  `PHOTO_STORAGE_DIR` to an absolute path on a persistent disk/volume.
- Private S3-compatible bucket: set `PHOTO_STORAGE_DRIVER=s3`, `PHOTO_S3_BUCKET`,
  `PHOTO_S3_REGION` and, if applicable, `PHOTO_S3_ENDPOINT`. Credentials may use the
  standard AWS credential provider for AWS itself. Custom endpoints require
  `PHOTO_S3_ACCESS_KEY_ID` and `PHOTO_S3_SECRET_ACCESS_KEY`, or the corresponding
  `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Set `PHOTO_S3_FORCE_PATH_STYLE=true` if required by
  the provider. The backend needs object read/write/delete access for the prefix.

For the supplied Railway bucket, configure these **server** variables:

```dotenv
PHOTO_STORAGE_DRIVER=s3
PHOTO_S3_BUCKET=pictures-of-website-pyhze
PHOTO_S3_ENDPOINT=https://t3.storageapi.dev
PHOTO_S3_REGION=auto
PHOTO_S3_FORCE_PATH_STYLE=false
PHOTO_S3_ACCESS_KEY_ID=
PHOTO_S3_SECRET_ACCESS_KEY=
```

Fill the two empty values from the bucket's Credentials tab in the server's
environment or untracked `server/.env`, then restart the backend. The supplied
endpoint, region and bucket are configured locally; access keys were not supplied,
so the live bucket connection has not been verified. Missing credentials return
a configuration error without attempting an upload.

Railway's standard `AWS_ENDPOINT_URL`, `AWS_S3_BUCKET_NAME`, `AWS_DEFAULT_REGION`
and `AWS_S3_URL_STYLE` variables are also accepted when the matching `PHOTO_S3_`
override is unset. Use `virtual` URL style unless the bucket's Credentials tab
explicitly specifies path style. See [Railway bucket documentation](https://docs.railway.com/storage-buckets)
and [Railway CLI credential variables](https://docs.railway.com/cli/bucket).

The application does not provision a paid cloud bucket automatically. Never put
bucket secrets into `VITE_` variables or make the bucket public. Browser uploads
go through the authenticated backend, so bucket CORS/public URLs are unnecessary.

New object keys use `daily-orders/YYYY-MM-DD/STORE_ID/UPLOAD_UUID/full.webp` and
`thumb.webp`. Catalog images use the separate `catalog/PRODUCT_ID/UPLOAD_UUID/`
prefix, also containing `full.webp` and `thumb.webp`. Existing `.jpg` objects
continue to work with their original content type; this change does not rewrite
old files or break shared-photo references. Both S3 metadata and download headers
match the stored format. Conversion occurs on the server after upload, so it saves
catalog download bandwidth, not the original phone-to-server upload bandwidth.

## Customer catalog

Open **كتالوج العملاء** from the dashboard, product screen or mobile menu. Choose
products from either shop, upload up to 12 photos per item and write a separate
customer description. Enable the item's catalog checkbox and save. Existing
products start hidden; internal product notes are never used as catalog copy.
The first active photo is the cover. Removing the last photo hides the product.
Use **استخدام صور صنف آخر** in an item's editor to reuse photos across models.
Search for the source item and select its photos. Every model keeps its own name,
price and description. Photo links share the same stored object; removing a link
only affects that model, and repeated linking does not create duplicates.

The administrator chooses the saved selling-price default (initially hidden).
Every fresh catalog opening uses it; the catalog's show/hide switch changes only
the current view. Purchase costs, margins and inventory figures are never sent
to customer mode.

**فتح وضع العملاء** ends the current admin session and opens a standalone,
read-only catalog for the shop device. Returning to administration requires login.
Catalog sessions expire after 12 hours, are stored only in the current browser tab,
and cannot access admin endpoints. This is not a public website or shareable link.
Do not leave other already-open admin screens on a device handed to a customer.

Catalog records/settings are included in database backups; catalog sessions are
not. Image bytes remain in the bucket and need their own backup. Removed images
are hidden rather than destroyed, preserving consistency with older backups.

Database backups include photo metadata, **not image bytes**. Back up the local
photo directory separately or enable bucket backup/versioning. Restore metadata
and objects together; do not delete bucket objects simply because an older database
backup lacks their rows.

Implementation references: [Sharp input options](https://sharp.pixelplumbing.com/api-constructor/)
and [official S3 JavaScript examples](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html).

Run unit tests with `node --test server/test/order-photos.test.js`. For the API
integration test, use a migrated disposable PostgreSQL database and set
`PHOTO_INTEGRATION_DATABASE_URL` before running
`node --test server/test/order-photos.integration.test.js`.
