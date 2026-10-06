import path from 'node:path';

const dataDir = process.env.ODC_DATA_DIR || '/data';

export const config = {
  port: Number(process.env.PORT || 8080),
  httpsPort: Number(process.env.ODC_HTTPS_PORT || 8443),
  dataDir,
  dbPath: path.join(dataDir, 'odc.db'),
  libraryDir: path.join(dataDir, 'library'),
  uploadsDir: path.join(dataDir, 'uploads'),
  cacheDir: path.join(dataDir, 'cache'),
  publicDir: path.resolve(new URL('../public', import.meta.url).pathname),
  ffmpeg: process.env.ODC_FFMPEG || 'ffmpeg',
  ffprobe: process.env.ODC_FFPROBE || 'ffprobe',
  // Set when the server sits behind a reverse proxy that sets X-Forwarded-For.
  trustProxy: process.env.ODC_TRUST_PROXY === '1',
  version: '2.0.0',
};
