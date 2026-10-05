// Auth gate. Next 16 renamed the `middleware` file convention to `proxy`
// (see node_modules/next/dist/docs/.../file-conventions/proxy.md); Clerk's
// clerkMiddleware returns a standard request handler that works as the proxy
// default export. Signed-out users hitting /dashboard are sent to /login.
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtectedRoute = createRouteMatcher(["/dashboard(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect({
      // Keep the hosted Clerk sign-in out of it: bounce to our own /login.
      unauthenticatedUrl: new URL("/login", req.url).toString(),
    });
  }
});

export const config = {
  matcher: [
    // Run on everything except Next internals and static assets, so auth
    // redirects never block CSS, JS, or images from loading.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|gif|png|svg|ico|webp|avif|woff2?|ttf|otf|map)).*)",
    // Always run on API and tRPC routes.
    "/(api|trpc)(.*)",
  ],
};
