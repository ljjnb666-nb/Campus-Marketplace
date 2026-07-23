import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  NEXTAUTH_URL: z.string().url(),
  NEXTAUTH_SECRET: z.string().min(16),
  APP_NAME: z.string().default("校园集市"),
  DEFAULT_CAMPUS_SLUG: z.string().default("main-campus"),
  UPLOAD_DIR: z.string().default("./public/uploads"),
});

export const env = envSchema.parse({
  DATABASE_URL: process.env.DATABASE_URL,
  NEXTAUTH_URL: process.env.NEXTAUTH_URL,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
  APP_NAME: process.env.APP_NAME,
  DEFAULT_CAMPUS_SLUG: process.env.DEFAULT_CAMPUS_SLUG,
  UPLOAD_DIR: process.env.UPLOAD_DIR,
});
