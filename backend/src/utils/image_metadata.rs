//! Removes embedded metadata from uploaded images before they are stored.
//!
//! Avatars are served from a public, unauthenticated URL, so anything the
//! camera wrote into the file travels with it: EXIF GPS coordinates, capture
//! timestamps, and camera serial numbers. The mobile client re-encodes before
//! uploading, but the web client sends the file as chosen and a direct API call
//! bypasses any client entirely, so the guarantee has to live on the server.
//!
//! These functions walk container structure only — segment and chunk headers —
//! and never decode pixel data, so stripping adds no image-decoder attack
//! surface. Anything that cannot be parsed confidently returns `None` and the
//! caller rejects the upload rather than storing metadata it failed to remove.

/// Strip metadata for one of the supported avatar formats. Returns `None` when
/// the container cannot be parsed, which the caller must treat as a refusal.
pub fn strip_metadata(bytes: &[u8], extension: &str) -> Option<Vec<u8>> {
    match extension {
        "jpg" | "jpeg" => strip_jpeg(bytes),
        "png" => strip_png(bytes),
        "webp" => strip_webp(bytes),
        "gif" => strip_gif(bytes),
        _ => None,
    }
}

/// JFIF, ICC colour profiles and the Adobe colour transform change how the
/// image renders, so they stay. Every other application segment is metadata:
/// APP1 carries EXIF and XMP, APP13 carries IPTC.
fn keep_jpeg_segment(marker: u8) -> bool {
    match marker {
        0xe0 | 0xe2 | 0xee => true,
        0xe1..=0xef => false,
        0xfe => false, // free-text comment
        _ => true,
    }
}

fn strip_jpeg(bytes: &[u8]) -> Option<Vec<u8>> {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len());
    out.extend_from_slice(&[0xff, 0xd8]);

    let mut offset = 2;
    loop {
        if *bytes.get(offset)? != 0xff {
            return None;
        }
        // A marker may be preceded by any number of 0xff fill bytes.
        let mut marker_offset = offset;
        while *bytes.get(marker_offset)? == 0xff {
            marker_offset += 1;
        }
        let marker = *bytes.get(marker_offset)?;
        let after_marker = marker_offset.checked_add(1)?;

        match marker {
            // Start of scan: the entropy-coded data that follows has no segment
            // length, so the remainder is copied verbatim.
            0xda => {
                out.extend_from_slice(bytes.get(offset..)?);
                return Some(out);
            }
            0xd9 => {
                out.extend_from_slice(&[0xff, 0xd9]);
                return Some(out);
            }
            // Markers that stand alone without a payload.
            0x01 | 0xd0..=0xd7 => {
                out.extend_from_slice(bytes.get(offset..after_marker)?);
                offset = after_marker;
            }
            _ => {
                let length = u16::from_be_bytes(
                    bytes
                        .get(after_marker..after_marker.checked_add(2)?)?
                        .try_into()
                        .ok()?,
                ) as usize;
                if length < 2 {
                    return None;
                }
                let segment_end = after_marker.checked_add(length)?;
                if segment_end > bytes.len() {
                    return None;
                }
                if keep_jpeg_segment(marker) {
                    out.extend_from_slice(bytes.get(offset..segment_end)?);
                }
                offset = segment_end;
            }
        }
    }
}

/// Critical chunks carry the image itself and must survive. Ancillary chunks
/// are optional by specification, so only the ones that affect rendering are
/// kept; that drops `eXIf`, `tEXt`, `zTXt`, `iTXt` and `tIME` by default rather
/// than by enumeration, so a future metadata chunk is removed without a change.
fn keep_png_chunk(chunk_type: &[u8; 4]) -> bool {
    if chunk_type[0].is_ascii_uppercase() {
        return true;
    }
    const KEPT: &[&[u8; 4]] = &[
        b"tRNS", b"gAMA", b"cHRM", b"sRGB", b"iCCP", b"sBIT", b"bKGD", b"pHYs",
        // Animation control, so an animated PNG keeps playing.
        b"acTL", b"fcTL", b"fdAT",
    ];
    KEPT.contains(&chunk_type)
}

fn strip_png(bytes: &[u8]) -> Option<Vec<u8>> {
    const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 8 || bytes.get(..8)? != SIGNATURE {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len());
    out.extend_from_slice(SIGNATURE);

    let mut offset: usize = 8;
    loop {
        let length = u32::from_be_bytes(bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?)
            as usize;
        let chunk_type: [u8; 4] = bytes
            .get(offset.checked_add(4)?..offset.checked_add(8)?)?
            .try_into()
            .ok()?;
        // length + type + data + CRC
        let chunk_end = offset.checked_add(12)?.checked_add(length)?;
        if chunk_end > bytes.len() {
            return None;
        }
        if keep_png_chunk(&chunk_type) {
            out.extend_from_slice(bytes.get(offset..chunk_end)?);
        }
        offset = chunk_end;
        if &chunk_type == b"IEND" {
            return Some(out);
        }
    }
}

fn strip_webp(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() < 12 || !bytes.starts_with(b"RIFF") || bytes.get(8..12)? != b"WEBP" {
        return None;
    }
    // Simple lossy/lossless files have no container for metadata at all.
    if bytes.get(12..16)? != b"VP8X" {
        return Some(bytes.to_vec());
    }

    let mut payload = Vec::with_capacity(bytes.len());
    payload.extend_from_slice(b"WEBP");

    let mut offset = 12;
    while offset < bytes.len() {
        let chunk_type: [u8; 4] = bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?;
        let size = u32::from_le_bytes(
            bytes
                .get(offset.checked_add(4)?..offset.checked_add(8)?)?
                .try_into()
                .ok()?,
        ) as usize;
        // RIFF chunks are padded to an even length.
        let chunk_end = offset
            .checked_add(8)?
            .checked_add(size)?
            .checked_add(size & 1)?;
        if chunk_end > bytes.len() {
            return None;
        }

        if &chunk_type == b"EXIF" || &chunk_type == b"XMP " {
            offset = chunk_end;
            continue;
        }
        let chunk_start = payload.len();
        payload.extend_from_slice(bytes.get(offset..chunk_end)?);
        if &chunk_type == b"VP8X" {
            // Clear the EXIF (0x08) and XMP (0x04) feature bits so the header
            // no longer advertises chunks that were just removed.
            *payload.get_mut(chunk_start.checked_add(8)?)? &= !0x0c;
        }
        offset = chunk_end;
    }
    if offset != bytes.len() {
        return None;
    }

    let mut out = Vec::with_capacity(payload.len().checked_add(8)?);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&u32::try_from(payload.len()).ok()?.to_le_bytes());
    out.extend_from_slice(&payload);
    Some(out)
}

/// Walk a chain of GIF sub-blocks and return the offset just past its
/// terminating zero-length block.
fn gif_sub_blocks_end(bytes: &[u8], mut offset: usize) -> Option<usize> {
    loop {
        let length = *bytes.get(offset)? as usize;
        offset = offset.checked_add(1)?;
        if length == 0 {
            return Some(offset);
        }
        offset = offset.checked_add(length)?;
        if offset > bytes.len() {
            return None;
        }
    }
}

fn strip_gif(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() < 13 || (!bytes.starts_with(b"GIF87a") && !bytes.starts_with(b"GIF89a")) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len());
    out.extend_from_slice(bytes.get(..13)?);

    let mut offset: usize = 13;
    let screen_descriptor = *bytes.get(10)?;
    if screen_descriptor & 0x80 != 0 {
        let table_end = offset.checked_add(3 * (1usize << ((screen_descriptor & 0x07) + 1)))?;
        out.extend_from_slice(bytes.get(offset..table_end)?);
        offset = table_end;
    }

    loop {
        match *bytes.get(offset)? {
            0x3b => {
                out.push(0x3b);
                return Some(out);
            }
            0x2c => {
                let packed = *bytes.get(offset.checked_add(9)?)?;
                let mut cursor = offset.checked_add(10)?;
                if packed & 0x80 != 0 {
                    cursor = cursor.checked_add(3 * (1usize << ((packed & 0x07) + 1)))?;
                }
                // Skip the LZW minimum code size, then the image data blocks.
                cursor = cursor.checked_add(1)?;
                let end = gif_sub_blocks_end(bytes, cursor)?;
                out.extend_from_slice(bytes.get(offset..end)?);
                offset = end;
            }
            0x21 => {
                let label = *bytes.get(offset.checked_add(1)?)?;
                let end = gif_sub_blocks_end(bytes, offset.checked_add(2)?)?;
                if keep_gif_extension(label, bytes.get(offset..end)?) {
                    out.extend_from_slice(bytes.get(offset..end)?);
                }
                offset = end;
            }
            _ => return None,
        }
    }
}

/// Comment extensions are free text. Application extensions can carry XMP, so
/// only the animation-control identifiers are kept — dropping those would make
/// an animated avatar play once instead of looping.
fn keep_gif_extension(label: u8, block: &[u8]) -> bool {
    match label {
        0xfe => false,
        0xff => {
            let identifier = block.get(3..11);
            matches!(identifier, Some(b"NETSCAPE") | Some(b"ANIMEXTS"))
        }
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// EXIF payload carrying a recognisable GPS byte pattern.
    const GPS_MARKER: &[u8] = b"Exif\0\0GPSLatitude44.4268";

    fn jpeg_segment(marker: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![0xff, marker];
        out.extend_from_slice(&u16::try_from(payload.len() + 2).unwrap().to_be_bytes());
        out.extend_from_slice(payload);
        out
    }

    /// SOI, APP0, the requested extra segments, SOF0, SOS with scan data, EOI.
    fn jpeg_with(extra: Vec<Vec<u8>>) -> Vec<u8> {
        let mut out = vec![0xff, 0xd8];
        out.extend(jpeg_segment(0xe0, b"JFIF\0\x01\x02\0\0\x01\0\x01\0\0"));
        for segment in extra {
            out.extend(segment);
        }
        // SOF0: precision, height 64, width 64, one component.
        out.extend(jpeg_segment(
            0xc0,
            &[0x08, 0x00, 0x40, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00],
        ));
        out.extend(jpeg_segment(0xda, &[0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]));
        out.extend_from_slice(b"SCANDATA");
        out.extend_from_slice(&[0xff, 0xd9]);
        out
    }

    fn png_chunk(chunk_type: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = u32::try_from(data.len()).unwrap().to_be_bytes().to_vec();
        out.extend_from_slice(chunk_type);
        out.extend_from_slice(data);
        out.extend_from_slice(&[0, 0, 0, 0]); // CRC is not verified here
        out
    }

    fn png_with(extra: Vec<Vec<u8>>) -> Vec<u8> {
        let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
        out.extend(png_chunk(
            b"IHDR",
            &[0, 0, 0, 64, 0, 0, 0, 64, 8, 6, 0, 0, 0],
        ));
        for chunk in extra {
            out.extend(chunk);
        }
        out.extend(png_chunk(b"IDAT", b"PIXELS"));
        out.extend(png_chunk(b"IEND", b""));
        out
    }

    fn riff_chunk(chunk_type: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = chunk_type.to_vec();
        out.extend_from_slice(&u32::try_from(data.len()).unwrap().to_le_bytes());
        out.extend_from_slice(data);
        if data.len() % 2 == 1 {
            out.push(0);
        }
        out
    }

    fn webp_extended(flags: u8, extra: Vec<Vec<u8>>) -> Vec<u8> {
        let mut payload = b"WEBP".to_vec();
        payload.extend(riff_chunk(b"VP8X", &[flags, 0, 0, 0, 63, 0, 0, 63, 0, 0]));
        payload.extend(riff_chunk(b"VP8 ", b"LOSSYDATA"));
        for chunk in extra {
            payload.extend(chunk);
        }
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&u32::try_from(payload.len()).unwrap().to_le_bytes());
        out.extend_from_slice(&payload);
        out
    }

    fn gif_extension(label: u8, blocks: &[&[u8]]) -> Vec<u8> {
        let mut out = vec![0x21, label];
        for block in blocks {
            out.push(u8::try_from(block.len()).unwrap());
            out.extend_from_slice(block);
        }
        out.push(0);
        out
    }

    fn gif_with(extra: Vec<Vec<u8>>) -> Vec<u8> {
        // Header, logical screen descriptor without a global colour table.
        let mut out = b"GIF89a".to_vec();
        out.extend_from_slice(&[64, 0, 64, 0, 0x00, 0, 0]);
        for block in extra {
            out.extend(block);
        }
        // Image descriptor with no local colour table, then one data block.
        out.extend_from_slice(&[0x2c, 0, 0, 0, 0, 64, 0, 64, 0, 0x00]);
        out.push(0x02); // LZW minimum code size
        out.extend_from_slice(&[0x03, b'A', b'B', b'C', 0x00]);
        out.push(0x3b);
        out
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }

    // ── JPEG ────────────────────────────────────────────────────

    #[test]
    fn jpeg_drops_exif_but_keeps_image_and_rendering_segments() {
        let original = jpeg_with(vec![
            jpeg_segment(0xe1, GPS_MARKER),        // EXIF with GPS
            jpeg_segment(0xe2, b"ICC_PROFILE\0x"), // colour profile
            jpeg_segment(0xed, b"Photoshop3.0"),   // IPTC
            jpeg_segment(0xfe, b"a comment"),
        ]);
        assert!(contains(&original, GPS_MARKER));

        let stripped = strip_jpeg(&original).unwrap();

        assert!(!contains(&stripped, GPS_MARKER), "GPS data survived");
        assert!(!contains(&stripped, b"Photoshop3.0"));
        assert!(!contains(&stripped, b"a comment"));
        // Rendering-relevant segments and the pixel data are untouched.
        assert!(contains(&stripped, b"ICC_PROFILE"));
        assert!(contains(&stripped, b"JFIF"));
        assert!(contains(&stripped, b"SCANDATA"));
        assert!(stripped.starts_with(&[0xff, 0xd8]) && stripped.ends_with(&[0xff, 0xd9]));
    }

    #[test]
    fn jpeg_without_metadata_keeps_every_byte() {
        let original = jpeg_with(vec![]);
        assert_eq!(strip_jpeg(&original).unwrap(), original);
    }

    #[test]
    fn jpeg_rejects_a_truncated_segment() {
        let mut broken = jpeg_with(vec![jpeg_segment(0xe1, GPS_MARKER)]);
        broken.truncate(12);
        assert!(strip_jpeg(&broken).is_none());
    }

    // ── PNG ─────────────────────────────────────────────────────

    #[test]
    fn png_drops_exif_and_text_but_keeps_critical_chunks() {
        let original = png_with(vec![
            png_chunk(b"eXIf", GPS_MARKER),
            png_chunk(b"tEXt", b"Comment\0secret"),
            png_chunk(b"iTXt", b"XML:com.adobe.xmp"),
            png_chunk(b"tIME", &[0x07, 0xe8, 1, 1, 0, 0, 0]),
            png_chunk(b"iCCP", b"profile"),
        ]);
        assert!(contains(&original, GPS_MARKER));

        let stripped = strip_png(&original).unwrap();

        assert!(!contains(&stripped, GPS_MARKER), "GPS data survived");
        assert!(!contains(&stripped, b"secret"));
        assert!(!contains(&stripped, b"XML:com.adobe.xmp"));
        assert!(!contains(&stripped, b"tIME"));
        assert!(contains(&stripped, b"iCCP"));
        assert!(contains(&stripped, b"IHDR"));
        assert!(contains(&stripped, b"PIXELS"));
        assert!(stripped.ends_with(b"IEND\0\0\0\0"));
    }

    #[test]
    fn png_rejects_a_chunk_length_past_the_end() {
        let mut broken = b"\x89PNG\r\n\x1a\n".to_vec();
        broken.extend_from_slice(&u32::MAX.to_be_bytes());
        broken.extend_from_slice(b"IHDR");
        assert!(strip_png(&broken).is_none());
    }

    // ── WebP ────────────────────────────────────────────────────

    #[test]
    fn webp_drops_exif_and_clears_the_feature_flag() {
        // 0x08 advertises EXIF, 0x20 advertises an ICC profile.
        let original = webp_extended(0x28, vec![riff_chunk(b"EXIF", GPS_MARKER)]);
        assert!(contains(&original, GPS_MARKER));

        let stripped = strip_webp(&original).unwrap();

        assert!(!contains(&stripped, GPS_MARKER), "GPS data survived");
        assert!(contains(&stripped, b"LOSSYDATA"));
        // The EXIF bit is cleared while the ICC bit is preserved.
        assert_eq!(stripped[20] & 0x08, 0);
        assert_eq!(stripped[20] & 0x20, 0x20);
        // The RIFF size still describes everything after the size field.
        let declared = u32::from_le_bytes(stripped[4..8].try_into().unwrap()) as usize;
        assert_eq!(declared, stripped.len() - 8);
    }

    #[test]
    fn webp_simple_format_is_returned_unchanged() {
        let mut payload = b"WEBP".to_vec();
        payload.extend(riff_chunk(b"VP8 ", b"LOSSYDATA"));
        let mut original = b"RIFF".to_vec();
        original.extend_from_slice(&u32::try_from(payload.len()).unwrap().to_le_bytes());
        original.extend_from_slice(&payload);

        assert_eq!(strip_webp(&original).unwrap(), original);
    }

    // ── GIF ─────────────────────────────────────────────────────

    #[test]
    fn gif_drops_comments_and_xmp_but_keeps_animation_control() {
        let original = gif_with(vec![
            gif_extension(0xfe, &[b"a comment"]),
            gif_extension(0xff, &[b"XMP DataXMP", GPS_MARKER]),
            gif_extension(0xff, &[b"NETSCAPE2.0", &[0x01, 0x00, 0x00]]),
        ]);
        assert!(contains(&original, GPS_MARKER));

        let stripped = strip_gif(&original).unwrap();

        assert!(!contains(&stripped, GPS_MARKER), "GPS data survived");
        assert!(!contains(&stripped, b"a comment"));
        assert!(!contains(&stripped, b"XMP DataXMP"));
        assert!(contains(&stripped, b"NETSCAPE2.0"));
        assert!(contains(&stripped, b"ABC"));
        assert_eq!(stripped.last(), Some(&0x3b));
    }

    #[test]
    fn gif_rejects_an_unterminated_sub_block_chain() {
        let mut broken = gif_with(vec![]);
        broken.truncate(20);
        assert!(strip_gif(&broken).is_none());
    }

    // ── dispatch ────────────────────────────────────────────────

    #[test]
    fn unsupported_extensions_are_refused() {
        assert!(strip_metadata(&jpeg_with(vec![]), "bmp").is_none());
    }

    #[test]
    fn dispatch_routes_each_supported_extension() {
        assert!(strip_metadata(&jpeg_with(vec![]), "jpg").is_some());
        assert!(strip_metadata(&png_with(vec![]), "png").is_some());
        assert!(strip_metadata(&webp_extended(0x00, vec![]), "webp").is_some());
        assert!(strip_metadata(&gif_with(vec![]), "gif").is_some());
    }
}
