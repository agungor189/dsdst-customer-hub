import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "../config.js";
import type { CustomerHubPermission, PanelUser } from "../../shared/contracts/domain.js";
import { panelMe } from "../panel/client.js";

declare global {
  namespace Express { interface Request { panelUser?: PanelUser; panelToken?: string } }
}

export const hasPermission = (user: PanelUser, permission: CustomerHubPermission) => user.role === "admin" || (user.role !== "readonly" && user.permissions?.[permission] === true) || (permission === "customer_hub:view" && user.permissions?.[permission] === true);

export function createAuthMiddleware(config: AppConfig, verify = panelMe) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = req.cookies?.[config.sessionCookieName];
    if (!token) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Oturum gerekli." } });
    try {
      const user = await verify(config, token);
      if (!hasPermission(user, "customer_hub:view")) return res.status(403).json({ error: { code: "FORBIDDEN", message: "Customer Hub görüntüleme izni gerekli." } });
      req.panelUser = user; req.panelToken = token; next();
    } catch (error: any) {
      return res.status(error?.status === 403 ? 403 : 401).json({ error: { code: "SESSION_INVALID", message: "Panel oturumu geçersiz veya süresi dolmuş." } });
    }
  };
}

export function requirePermission(permission: CustomerHubPermission) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.panelUser || !hasPermission(req.panelUser, permission)) return res.status(403).json({ error: { code: "FORBIDDEN", message: `${permission} izni gerekli.` } });
    next();
  };
}

export function csrfOrigin(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (["GET","HEAD","OPTIONS"].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && origin !== config.appOrigin) return res.status(403).json({ error: { code: "CSRF_ORIGIN_REJECTED", message: "Geçersiz istek kaynağı." } });
    next();
  };
}
