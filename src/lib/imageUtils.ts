import sharp from 'sharp';

export async function compressImageForRekognition(base64: string): Promise<Buffer> {
  const inputBuffer = Buffer.from(base64, 'base64');

  const compressed = await sharp(inputBuffer)
    .resize(640, 640, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 80 })
    .toBuffer();

  console.log('[IMAGE] original:', inputBuffer.length, 'bytes');
  console.log('[IMAGE] compressed:', compressed.length, 'bytes');
  console.log(
    '[IMAGE] ratio:',
    Math.round((compressed.length / inputBuffer.length) * 100) + '%'
  );

  return compressed;
}
