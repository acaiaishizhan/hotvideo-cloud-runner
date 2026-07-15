import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSystemPromptForMeta,
  SYSTEM_PROMPT,
} from './prompt.mjs';

test('buildSystemPromptForMeta keeps AI rules for the tech category', () => {
  const prompt = buildSystemPromptForMeta({
    scraped: { sourceType: '科技/科技科普' },
  });

  assert.match(prompt, /AI 工具教程/);
  assert.match(prompt, /与 AI 技术、科技科普无关/);
});

test('buildSystemPromptForMeta uses humanities rules for guoxue category', () => {
  const prompt = buildSystemPromptForMeta({
    scraped: { sourceType: '人文社科/国学' },
  });

  assert.match(prompt, /国学经典/);
  assert.match(prompt, /面向中老年人的人生经验/);
  assert.doesNotMatch(prompt, /与 AI 技术、科技科普无关/);
});

test('default SYSTEM_PROMPT remains the tech prompt for legacy callers', () => {
  assert.match(SYSTEM_PROMPT, /AI 和科技科普领域/);
});
