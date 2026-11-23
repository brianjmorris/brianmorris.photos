import type { OwnerIdentity } from './auth/owner.ts';

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
    }
  }
}
