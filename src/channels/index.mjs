// 通道注册表。新增通道只需在这里挂一个 create 函数，网关与 hook 都不用动。

import { create as createMock } from './mock.mjs';
import { create as createHa } from './ha.mjs';
import { create as createPushcut } from './pushcut.mjs';

const REGISTRY = {
  mock: createMock,
  ha: createHa,
  pushcut: createPushcut,
};

export function createChannel(name, channelsCfg, deps) {
  const factory = REGISTRY[name];
  if (!factory) {
    throw new Error(`未知通道 ${name}，可选：${Object.keys(REGISTRY).join(' / ')}`);
  }
  const cfg = (channelsCfg && channelsCfg[name]) || {};
  const ch = factory(cfg, deps);
  ch.name = name;
  return ch;
}

export function availableChannels() {
  return Object.keys(REGISTRY);
}
