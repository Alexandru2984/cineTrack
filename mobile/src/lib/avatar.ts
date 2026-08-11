import { File } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { z } from 'zod';

import { apiMultipartRequest, apiRequest } from '@/lib/api';
import { ApiError } from '@/lib/http';

const AVATAR_EDGE_PX = 1024;

const avatarResponseSchema = z.object({
  avatar_url: z
    .string()
    .url()
    .max(2_048)
    .refine((url) => new URL(url).protocol === 'https:', 'Avatar URL must use HTTPS'),
});

export interface PreparedAvatar {
  uri: string;
  name: string;
  mimeType: 'image/jpeg';
}

/**
 * The system picker grants access to one explicitly selected image. Re-encoding
 * it strips metadata and converts formats such as HEIC before the server's
 * independent content, size, and pixel validation.
 */
export async function pickAndPrepareAvatar(): Promise<PreparedAvatar | null> {
  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
    base64: false,
    exif: false,
    selectionLimit: 1,
  });
  if (picked.canceled) return null;

  const asset = picked.assets[0];
  if (!asset?.uri || asset.type === 'video' || asset.width <= 0 || asset.height <= 0) {
    throw new ApiError('Choose a valid image', 400);
  }

  const manipulator = ImageManipulator.ImageManipulator.manipulate(asset.uri);
  const largestEdge = Math.max(asset.width, asset.height);
  if (largestEdge > AVATAR_EDGE_PX) {
    if (asset.width >= asset.height) {
      manipulator.resize({ width: AVATAR_EDGE_PX, height: null });
    } else {
      manipulator.resize({ width: null, height: AVATAR_EDGE_PX });
    }
  }
  const rendered = await manipulator.renderAsync();
  const output = await rendered.saveAsync({
    format: ImageManipulator.SaveFormat.JPEG,
    compress: 0.82,
    base64: false,
  });
  if (!output.uri || output.width <= 0 || output.height <= 0) {
    throw new ApiError('The selected image could not be prepared', 400);
  }

  // The upload reads this path from native code, where a missing or empty file
  // fails without ever reaching the network — and, before the error cause was
  // preserved, without saying so. Check it here, where the message can name
  // what is actually wrong.
  const prepared = new File(output.uri);
  if (!prepared.exists) {
    throw new ApiError('The prepared image is no longer on disk', 400);
  }
  if (!prepared.size) {
    throw new ApiError('The prepared image is empty', 400);
  }

  return {
    uri: output.uri,
    name: 'avatar.jpg',
    mimeType: 'image/jpeg',
  };
}

export async function uploadAvatar(file: PreparedAvatar) {
  const payload = await apiMultipartRequest<unknown>('/users/me/avatar', {
    uri: file.uri,
    fieldName: 'avatar',
    mimeType: file.mimeType,
  });
  return avatarResponseSchema.parse(payload);
}

export async function deleteAvatar() {
  await apiRequest<{ message: string }>('/users/me/avatar', { method: 'DELETE' });
}
