import config from './config.mjs';

async function scrape() {
  throw new Error('云端 runner 不负责抓榜；请由 Windows 登录态生成 queue manifest');
}

export default {
  name: 'douyin-hotspot',
  config,
  scrape,
};
