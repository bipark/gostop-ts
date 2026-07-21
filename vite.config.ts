import { defineConfig } from 'vite';

// GitHub Pages(https://bipark.github.io/gostop-ts/)는 하위경로로 서빙되므로
// 프로덕션 빌드에서만 base를 저장소 이름으로 맞춘다. dev 서버는 항상 루트('/').
//
// 포크해서 다른 저장소 이름으로 배포하려면 빌드 시 BASE_PATH를 넘기면 된다.
//   BASE_PATH=/my-repo/ npm run build
// 루트 도메인(Vercel/Netlify/Cloudflare/커스텀 도메인)에 올릴 땐:
//   BASE_PATH=/ npm run build
export default defineConfig(({ command }) => ({
  base: process.env.BASE_PATH ?? (command === 'build' ? '/gostop-ts/' : '/'),
}));
