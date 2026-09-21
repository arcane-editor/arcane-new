import { z } from 'astro/zod';

export const editorialSchema = (kind: 'blog' | 'comparisons' | 'features') =>
  z.object({
    title: z.string().min(10),
    description: z.string().min(40).max(220),
    topic: z.string(),
    author: z.object({ name: z.literal('UnityIDE team'), url: z.literal('/about/') }),
    draft: z.boolean().default(true),
    publishedAt: z.coerce.date().optional(),
    updatedAt: z.coerce.date().optional(),
    updateNote: z.string().optional(),
    researchedAt: z.coerce.date(),
    verification: z.object({
      status: z.enum(['pending', 'documented', 'tested']),
      summary: z.string().min(20),
      evidence: z.string().optional(),
    }),
    testedVersions: z.array(z.object({
      tool: z.string(), version: z.string(), platform: z.string(),
    })).default([]),
    image: z.object({
      src: z.string().startsWith('/'), alt: z.string().min(10),
      credit: z.string().min(1), source: z.string().url().optional(),
    }).optional(),
    sources: z.array(z.object({
      title: z.string(), url: z.string().url(), accessedAt: z.coerce.date(),
    })).min(1),
    related: z.array(z.object({
      collection: z.enum(['blog', 'comparisons', 'features']), id: z.string(),
    })).default([]),
  }).superRefine((entry, context) => {
    if (!entry.draft && !entry.publishedAt) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['publishedAt'], message: 'Published entries need a real publication date.' });
    }
    if (entry.updatedAt && (!entry.publishedAt || entry.updatedAt < entry.publishedAt || !entry.updateNote)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['updatedAt'], message: 'A substantive update needs a publication date, a later date, and an update note.' });
    }
    if (!entry.draft && entry.verification.status === 'pending') {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['verification'], message: 'Pending evidence cannot be published.' });
    }
    if (!entry.draft && kind === 'blog' && (entry.verification.status !== 'tested' || !entry.testedVersions.length || !entry.verification.evidence)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['verification'], message: 'Technical guides require actual test evidence and tested versions before publication.' });
    }
  });
