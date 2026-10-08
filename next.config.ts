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
  // 本机开发：放行局域网地址对 dev 资源（HMR、开发浮层）的访问。Next 16 默认
  // 只认 localhost，从 `http://192.168.1.58:3000`（例如用手机验 ≤767px 布局）
  // 打开时热更新会被拦截并打印 cross-origin 警告。
  //
  // 这是**本机专有**取值：换网络或换机器即失效，因此不入库，只留在工作区。
  allowedDevOrigins: ['192.168.1.58'],
};

export default nextConfig;
