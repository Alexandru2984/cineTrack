import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { apiMultipartRequest } from '@/lib/api';
import { pickAndPrepareAvatar, uploadAvatar } from '@/lib/avatar';
import { ApiError } from '@/lib/http';

const mockResize = jest.fn();
const mockRenderAsync = jest.fn();
const mockSaveAsync = jest.fn();
const mockManipulate = jest.fn();

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock('expo-image-manipulator', () => ({
  ImageManipulator: {
    manipulate: (...args: unknown[]) => mockManipulate(...args),
  },
  SaveFormat: { JPEG: 'jpeg' },
}));

jest.mock('@/lib/api', () => ({
  apiMultipartRequest: jest.fn(),
  apiRequest: jest.fn(),
}));

const mockPicker = jest.mocked(ImagePicker.launchImageLibraryAsync);
const mockUpload = jest.mocked(apiMultipartRequest);

describe('mobile avatar upload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockManipulate.mockReturnValue({ resize: mockResize, renderAsync: mockRenderAsync });
    mockRenderAsync.mockResolvedValue({ saveAsync: mockSaveAsync });
    mockSaveAsync.mockResolvedValue({
      uri: 'file:///cache/avatar.jpg',
      width: 1024,
      height: 768,
    });
  });

  it('uses the one-image system picker and strips metadata through JPEG re-encoding', async () => {
    mockPicker.mockResolvedValueOnce({
      canceled: false,
      assets: [
        {
          uri: 'file:///gallery/photo.heic',
          width: 4032,
          height: 3024,
          type: 'image',
          fileName: 'photo.heic',
          fileSize: 8_000_000,
          mimeType: 'image/heic',
        },
      ],
    });

    await expect(pickAndPrepareAvatar()).resolves.toEqual({
      uri: 'file:///cache/avatar.jpg',
      name: 'avatar.jpg',
      mimeType: 'image/jpeg',
    });
    expect(mockPicker).toHaveBeenCalledWith({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
      base64: false,
      exif: false,
      selectionLimit: 1,
    });
    expect(mockManipulate).toHaveBeenCalledWith('file:///gallery/photo.heic');
    expect(mockResize).toHaveBeenCalledWith({ width: 1024, height: null });
    expect(mockSaveAsync).toHaveBeenCalledWith({
      format: ImageManipulator.SaveFormat.JPEG,
      compress: 0.82,
      base64: false,
    });
  });

  it('does not upload after cancellation or invalid picker metadata', async () => {
    mockPicker
      .mockResolvedValueOnce({ canceled: true, assets: null })
      .mockResolvedValueOnce({
        canceled: false,
        assets: [{ uri: 'file:///bad', width: 0, height: 0, type: 'image' }],
      });

    await expect(pickAndPrepareAvatar()).resolves.toBeNull();
    await expect(pickAndPrepareAvatar()).rejects.toBeInstanceOf(ApiError);
    expect(mockManipulate).not.toHaveBeenCalled();
  });

  it('validates the server URL after multipart upload', async () => {
    mockUpload
      .mockResolvedValueOnce({ avatar_url: 'https://vazute.micutu.com/api/assets/avatar.jpg' })
      .mockResolvedValueOnce({ avatar_url: 'http://attacker.test/avatar.jpg' });
    const file = {
      uri: 'file:///cache/avatar.jpg',
      name: 'avatar.jpg',
      mimeType: 'image/jpeg' as const,
    };

    await expect(uploadAvatar(file)).resolves.toEqual({
      avatar_url: 'https://vazute.micutu.com/api/assets/avatar.jpg',
    });
    await expect(uploadAvatar(file)).rejects.toThrow('Avatar URL must use HTTPS');
    expect(mockUpload).toHaveBeenCalledWith('/users/me/avatar', expect.any(FormData));
  });
});
