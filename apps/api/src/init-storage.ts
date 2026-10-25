import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from './config.js';

const config = loadConfig();
const checkOnly = process.argv.includes('--check');
if (checkOnly && config.STORAGE_DRIVER !== 's3') throw new Error('Storage preflight requires S3.');
if (config.STORAGE_DRIVER === 's3') {
  const client = new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, forcePathStyle: true, credentials: { accessKeyId: config.S3_ACCESS_KEY ?? '', secretAccessKey: config.S3_SECRET_KEY ?? '' } });
  try {
    for (let attempt = 0; attempt < (checkOnly ? 1 : 30); attempt++) {
      try {
        try { await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET })); }
        catch (error) {
          if (!(error instanceof Error) || !['NotFound', 'NoSuchBucket'].includes(error.name)) throw error;
          if (checkOnly) throw new Error('The dedicated demo S3 bucket must already exist; --check never creates it.');
          await client.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }));
        }
        console.log('Object storage bucket is accessible. Bucket privacy is not verified by this check.');
        break;
      } catch (error) {
        if (checkOnly || attempt === 29) throw error;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  } finally { client.destroy(); }
} else console.log('Local development storage selected; no S3 bucket created.');
