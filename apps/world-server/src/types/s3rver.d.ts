declare module "s3rver" {
  export default class S3rver { constructor(opts: Record<string, unknown>); run(): Promise<{ address: string; port: number }>; close(): Promise<void> }
}
