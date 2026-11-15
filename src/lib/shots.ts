/** 网关把成交截图按账户目录暴露在本地静态路由上 */
export const SHOT_BASE = 'http://127.0.0.1:8765/shots';

export interface ShotKey {
  login: number;
  position_id: number;
}

/** 截图按账户分目录；旧版平铺文件由网关路由自动回退 */
export function shotUrl(key: ShotKey, ext = 'jpg'): string {
  return `${SHOT_BASE}/${key.login || 0}/${key.position_id}.${ext}`;
}
