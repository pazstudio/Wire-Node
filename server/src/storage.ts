import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { FastifyRequest } from 'fastify';

export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR ?? 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export interface SavedImage {
  imagePath: string;
  thumbPath: string;
  width: number;
  height: number;
}

class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

/**
 * Stores an uploaded image as WebP. EXIF orientation is applied ("baked in") so
 * the stored pixel size matches what browsers display; this keeps normalized
 * rectangle coordinates correct for phone photos.
 */
export async function saveImage(buf: Buffer): Promise<SavedImage> {
  const id = randomUUID();
  const imagePath = `${id}.webp`;
  const thumbPath = `${id}_thumb.webp`;
  try {
    const base = sharp(buf, { failOn: 'none' }).rotate();
    const info = await base
      .clone()
      .resize({ width: 8000, height: 8000, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90 })
      .toFile(path.join(UPLOAD_DIR, imagePath));
    await base
      .clone()
      .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(path.join(UPLOAD_DIR, thumbPath));
    return { imagePath, thumbPath, width: info.width, height: info.height };
  } catch (err) {
    await deleteFiles(imagePath, thumbPath);
    throw new HttpError(400, 'Unsupported or corrupt image file');
  }
}

export async function deleteFiles(...names: (string | null | undefined)[]) {
  await Promise.all(
    names
      .filter((n): n is string => !!n)
      .map((n) => fs.promises.rm(path.join(UPLOAD_DIR, path.basename(n)), { force: true })),
  );
}

/** Reads a multipart request: text fields plus at most one file. */
export async function readMultipart(req: FastifyRequest) {
  const fields: Record<string, string> = {};
  let file: Buffer | undefined;
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      const buf = await part.toBuffer();
      if (buf.length > 0) file = buf;
    } else {
      fields[part.fieldname] = String(part.value ?? '');
    }
  }
  return { fields, file };
}
