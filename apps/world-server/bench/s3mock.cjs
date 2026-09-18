// 로컬 S3 호환 mock (s3rver). 1M 저장소 벤치와 수동 확인용.  PORT=9000 BUCKET=pancake DIR=./data/s3 node --openssl-legacy-provider bench/s3mock.cjs
const S3rver = require("s3rver");
const port = Number(process.env.PORT ?? 9000), bucket = process.env.BUCKET ?? "pancake", directory = process.env.DIR ?? "./data/s3";
new S3rver({ port, address: "127.0.0.1", silent: true, directory, configureBuckets: [{ name: bucket }] }).run().then(() => console.log(`s3 mock http://127.0.0.1:${port} bucket ${bucket} dir ${directory}`));
