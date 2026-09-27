import { z } from "zod";

const optionalText = (max: number) => z.string().trim().max(max).optional();
export const websiteContextSchema = z.object({
  page_url: optionalText(2_000),
  current_url: optionalText(2_000),
  page_title: optionalText(300),
  referrer: optionalText(2_000),
  product_id: optionalText(120),
  product_handle: optionalText(200),
  product_title: optionalText(300),
  variant_id: optionalText(120),
  cart_url: optionalText(2_000),
}).strict().default({});

export const createSessionSchema = z.object({
  site_id: z.string().trim().min(1).max(250),
  visitor_id: z.string().regex(/^wv_[A-Za-z0-9_-]{32,80}$/).optional(),
  name: optionalText(120),
  email: z.string().trim().email().max(254).optional(),
  phone: optionalText(40),
}).strict();

export const publicMessageSchema = z.object({
  client_message_id: z.string().uuid(),
  body: z.string().trim().min(1).max(2_000),
  context: websiteContextSchema.optional(),
}).strict();

export const readMessagesSchema = z.object({
  message_ids: z.array(z.string().uuid()).min(1).max(100),
}).strict();

export const publicMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
