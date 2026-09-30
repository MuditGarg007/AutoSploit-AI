// App shell for every dashboard view: fixed left sidebar, sticky top bar, and a
// centered content column. This replaces the marketing floating navbar inside
// the dashboard so the two surfaces read as different products. Content is
// capped and gutter-padded; pages just render their sections into `children`.

import Sidebar from "./Sidebar";
import Topbar from "./Topbar";

export default function DashboardShell({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-canvas">
      <Sidebar />
      <div className="flex min-h-screen flex-col pl-60">
        <Topbar />
        <main className="flex-1">
          <div className="mx-auto w-full max-w-6xl px-6 py-8 sm:px-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
