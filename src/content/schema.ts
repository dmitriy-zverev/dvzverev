import { z } from 'zod';

const publishableString = z
  .string()
  .min(1)
  .refine((value) => !value.includes('[TBD]'), {
    message: 'Publishable fields must not contain [TBD]',
  });

export const navItemSchema = z.object({
  label: publishableString,
  href: publishableString,
});

export const faqItemSchema = z.object({
  question: publishableString,
  answer: publishableString,
});

export const serviceDirectionSchema = z.object({
  id: publishableString,
  title: publishableString,
  outcome: publishableString,
  examples: publishableString,
});

export const caseStudySchema = z.object({
  id: publishableString,
  name: publishableString,
  headline: publishableString,
  problem: publishableString,
  solution: publishableString,
  role: publishableString,
  result: publishableString,
  surfaceRoute: publishableString,
  systemRoute: publishableString,
  siteUrl: z.url(),
  isDemo: z.boolean().optional(),
});

export const siteSchema = z.object({
  canonicalBase: z.url(),
  telegramUrl: z.url(),
  githubUrl: z.url(),
  email: z.email().optional(),
  headerBrand: publishableString,
  headerRole: publishableString,
  fullName: publishableString,
  title: publishableString,
  description: publishableString,
  heroHeadline: publishableString,
  heroSubline: publishableString,
  heroCtaLabel: publishableString,
  heroCtaMicro: publishableString,
  heroSecondaryLabel: publishableString,
  xrayToggleLabel: publishableString,
  nav: z.array(navItemSchema).min(1),
  faq: z.array(faqItemSchema).min(1),
  principles: z.array(publishableString).min(1),
  stackGroups: z.array(
    z.object({
      role: publishableString,
      items: publishableString,
    }),
  ),
  aboutBio: publishableString,
  contactHeadline: publishableString,
  contactAccent: publishableString,
  contactSubline: publishableString,
  footerTagline: publishableString,
});

export type SiteContent = z.infer<typeof siteSchema>;
export type CaseStudy = z.infer<typeof caseStudySchema>;
export type ServiceDirection = z.infer<typeof serviceDirectionSchema>;
