import type { OwnerIdentity } from './auth/owner.ts';
import type { CatalogueDatabase } from './catalogue/d1.ts';
import type { DraftPhotoBucket } from './authoring/photo-attachments.ts';

declare global {
  namespace App {
    interface Locals {
      owner?: OwnerIdentity;
    }
  }
  namespace Cloudflare {
    interface Env {
      ACCESS_TEAM_DOMAIN?: string;
      ACCESS_AUDIENCE?: string;
      CATALOGUE?: CatalogueDatabase;
      DRAFT_PHOTOS?: DraftPhotoBucket;
    }
  }
}
