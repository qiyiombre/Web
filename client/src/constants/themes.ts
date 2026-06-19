import type { ThemeMode } from '../types/domain';

export interface ThemeOption {
  id: ThemeMode;
  label: string;
  description: string;
  swatches: [string, string, string];
}

export const THEME_OPTIONS: ThemeOption[] = [
  {
    id: 'deepSpace',
    label: '深空蓝',
    description: '保留星云气质，降低紫蓝霓虹浓度。',
    swatches: ['#62d6ff', '#6f8ed8', '#8ccfae']
  },
  {
    id: 'obsidian',
    label: '曜石青',
    description: '黑青和冷灰为主，更像专业工具台。',
    swatches: ['#6bd7cf', '#8fa8b5', '#9fbf95']
  },
  {
    id: 'ember',
    label: '暖灰琥珀',
    description: '低饱和暖色，减少 AI 生成感。',
    swatches: ['#e6b26e', '#78b7aa', '#cfc08f']
  },
  {
    id: 'moss',
    label: '苔原绿',
    description: '深绿、苔藓、灰黑，偏安静资料库感。',
    swatches: ['#9fbf78', '#5ea58a', '#b7ad82']
  },
  {
    id: 'burgundy',
    label: '酒红暗铜',
    description: '酒红、烟灰、暗铜，偏成熟日记感。',
    swatches: ['#c77a86', '#a88a63', '#7fa4a0']
  }
];

export function isThemeMode(value: unknown): value is ThemeMode {
  return THEME_OPTIONS.some((theme) => theme.id === value);
}

export function themeClassName(mode: ThemeMode) {
  return `theme-${mode.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)}`;
}
