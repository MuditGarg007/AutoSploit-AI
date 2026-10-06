import type { MetadataRoute } from "next";

// The dashboard is auth-gated and user-specific, so keep crawlers on the public
// marketing surfaces only. sitemap is omitted until there is more than one
// indexable page worth listing.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/dashboard", "/login", "/sso-callback"],
    },
    host: siteUrl,
  };
}
