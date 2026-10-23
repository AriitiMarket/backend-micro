/**
 * Image upload manager with Cloudinary integration
 * Handles file uploads, transformation, and CDN serving
 */

const cloudinary = require('cloudinary').v2;

class ImageUploadManager {
  constructor(config) {
    if (config?.cloudinary) {
      cloudinary.config(config.cloudinary);
    }
    this.cloudinaryConfigured = !!config?.cloudinary;
  }

  /**
   * Upload image to Cloudinary (or local fallback)
   */
  async uploadImage(file, options = {}) {
    const {
      folder = 'aritii',
      public_id = null,
      transformation = true
    } = options;

    if (!file) throw new Error('No file provided');

    try {
      if (this.cloudinaryConfigured) {
        return await this._uploadToCloudinary(file, folder, public_id, transformation);
      } else {
        return await this._uploadLocal(file);
      }
    } catch (error) {
      throw new Error(`Upload failed: ${error.message}`);
    }
  }

  /**
   * Upload multiple images
   */
  async uploadMultiple(files, options = {}) {
    const uploads = files.map(file => this.uploadImage(file, options));
    return Promise.all(uploads);
  }

  /**
   * Get optimized image URL with transformations
   */
  static getOptimizedUrl(url, options = {}) {
    if (!url) return null;

    const {
      width = null,
      height = null,
      quality = 'auto',
      format = 'auto',
      crop = 'fill'
    } = options;

    if (url.includes('cloudinary')) {
      return this._buildCloudinaryUrl(url, { width, height, quality, format, crop });
    }

    return url;
  }

  /**
   * Delete image
   */
  async deleteImage(imageId) {
    if (!this.cloudinaryConfigured) {
      return { success: true };
    }

    try {
      const result = await cloudinary.uploader.destroy(imageId);
      return { success: result.result === 'ok' };
    } catch (error) {
      console.error('Delete failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate responsive image variants
   */
  static generateVariants(baseUrl) {
    if (!baseUrl?.includes('cloudinary')) return { base: baseUrl };

    return {
      thumbnail: this.getOptimizedUrl(baseUrl, { width: 100, height: 100, crop: 'thumb' }),
      small: this.getOptimizedUrl(baseUrl, { width: 300, height: 300 }),
      medium: this.getOptimizedUrl(baseUrl, { width: 600, height: 600 }),
      large: this.getOptimizedUrl(baseUrl, { width: 1200, height: 1200 }),
      original: baseUrl
    };
  }

  // Private methods

  async _uploadToCloudinary(file, folder, public_id, transformation) {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          public_id,
          resource_type: 'auto',
          quality: 'auto',
          fetch_format: 'auto',
          transformation: transformation ? [
            { quality: 'auto:best', fetch_format: 'auto' }
          ] : undefined
        },
        (error, result) => {
          if (error) reject(error);
          else resolve({
            url: result.secure_url,
            publicId: result.public_id,
            cloudinaryId: result.version,
            width: result.width,
            height: result.height,
            size: result.bytes,
            format: result.format
          });
        }
      );

      stream.end(file.buffer);
    });
  }

  async _uploadLocal(file) {
    const fs = require('fs');
    const path = require('path');
    // Write to the SAME directory app.js serves at `/uploads`
    // (`src/app/../../uploads` → `src/uploads`); the manager lives at
    // `src/shared/media`, so `src/shared/media/../../uploads` resolves to it.
    // The previous `./uploads/images` resolved against the process CWD and was
    // never the served tree, so the returned URL always 404'd.
    const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'images');
    const safeName = path.basename(String(file.originalname || 'image'));
    const filename = `${Date.now()}-${Date.now().toString(36)}${path.extname(safeName) || '.png'}`;
    const filepath = path.join(uploadDir, filename);

    await fs.promises.mkdir(uploadDir, { recursive: true });
    await fs.promises.writeFile(filepath, file.buffer);

    return {
      url: `/uploads/images/${filename}`,
      filename,
      size: file.size || file.buffer.length,
      format: file.mimetype || null
    };
  }

  static _buildCloudinaryUrl(url, options) {
    const { width, height, quality, format, crop } = options;
    let transformations = [];

    if (width || height) {
      transformations.push(`w_${width || 'auto'}${height ? `,h_${height}` : ''},c_${crop}`);
    }
    if (quality) {
      transformations.push(`q_${quality}`);
    }
    if (format) {
      transformations.push(`f_${format}`);
    }

    if (transformations.length === 0) return url;

    // Insert transformations into URL
    const parts = url.split('/upload/');
    if (parts.length !== 2) return url;

    return `${parts[0]}/upload/${transformations.join('/')}/${parts[1]}`;
  }
}

module.exports = ImageUploadManager;
