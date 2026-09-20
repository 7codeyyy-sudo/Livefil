import type { Metadata } from 'next';

import { PlaceholderPage } from '../_components/PlaceholderPage';

export const metadata: Metadata = { title: '设置' };

/**
 * 设置页（`/settings`）。真实内容属 IAM-002。
 *
 * 本批只交付**路由与外壳内的可达性**：侧栏底部的「设置」是一个真实链接，
 * 指向这个真实路由。页面内容（账户、时区、偏好）等 IAM 落地。
 */
export default function SettingsPage() {
  return <PlaceholderPage title="设置" note="账户与偏好设置将在 IAM-002 交付。" />;
}
