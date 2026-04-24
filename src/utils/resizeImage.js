// Client-side image resizer for uploads to Claude Vision.
// Claude internally downscales anything over 1568px on the long edge,
// so shipping larger images is pure token waste. We resize + re-encode
// as JPEG (85% quality) before upload — invisible to the user.
//
// Returns { imageBase64, mimeType } ready for the /api endpoints.

const MAX_EDGE = 1568
const JPEG_QUALITY = 0.85

export async function fileToResizedBase64(file) {
  // Non-images (shouldn't happen, but be safe): pass through untouched.
  if (!file.type?.startsWith('image/')) {
    const base64 = await readAsBase64(file)
    return { imageBase64: base64, mimeType: file.type }
  }

  try {
    const dataUrl = await readAsDataURL(file)
    const img = await loadImage(dataUrl)

    const { width, height } = img
    const longest = Math.max(width, height)

    // Already small enough — just strip the data URL prefix and return as-is.
    if (longest <= MAX_EDGE) {
      return { imageBase64: dataUrl.split(',')[1], mimeType: file.type }
    }

    const scale = MAX_EDGE / longest
    const targetW = Math.round(width * scale)
    const targetH = Math.round(height * scale)

    const canvas = document.createElement('canvas')
    canvas.width = targetW
    canvas.height = targetH
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, targetW, targetH)

    const resizedDataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
    return { imageBase64: resizedDataUrl.split(',')[1], mimeType: 'image/jpeg' }
  } catch (err) {
    // On any failure, fall back to the original untouched file so upload still works.
    console.warn('[resizeImage] Falling back to original:', err)
    const base64 = await readAsBase64(file)
    return { imageBase64: base64, mimeType: file.type }
  }
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function readAsBase64(file) {
  const dataUrl = await readAsDataURL(file)
  return dataUrl.split(',')[1]
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}
