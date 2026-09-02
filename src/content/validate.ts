import { cases } from './cases';
import { site } from './site';
import { services } from './services';
import { caseStudySchema, siteSchema } from './schema';

export function validateContent(): void {
  siteSchema.parse(site);

  for (const caseStudy of cases) {
    caseStudySchema.parse(caseStudy);
  }

  if (services.length < 1) {
    throw new Error('At least one service direction is required');
  }
}

validateContent();
