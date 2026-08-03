import config from './config.mjs';
import { runScrape } from './scrape.mjs';

export default {
  name: 'youtube-ai',
  config,
  scrape: runScrape,
};
