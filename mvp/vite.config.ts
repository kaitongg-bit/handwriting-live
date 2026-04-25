import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // host:true 会枚举网卡，部分沙箱/CI 会报错；手机调试可用 npm run dev -- --host
  server: { host: '127.0.0.1', port: 5173, strictPort: false },
});
