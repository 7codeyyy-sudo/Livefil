import type { NextConfig } from 'next';
import { parseServerEnv } from './src/shared/validation/env';

// 构建期校验：非法环境变量会让 `next build` 在读取配置阶段就失败，
// 避免把错误配置带进产物。
//
// 注意：此处能否看到 `.env.local` 中的取值取决于 Next 加载环境变量的时序，
// 因此**启动期校验以 instrumentation.ts 为准**，本处只作为构建期的最早拦截。
parseServerEnv(process.env);

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
