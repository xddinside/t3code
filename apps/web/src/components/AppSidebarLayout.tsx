import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import ThreadSidebar from "./Sidebar";
import { Sidebar, SidebarProvider, SidebarRail } from "./ui/sidebar";
import { useMediaQuery } from "~/hooks/useMediaQuery";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH_DESKTOP = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH_DESKTOP = 40 * 16;
const THREAD_SIDEBAR_MIN_WIDTH_MOBILE = 10 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH_MOBILE = 20 * 16;

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const isMobile = useMediaQuery("max-sm");

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  return (
    <SidebarProvider defaultOpen={!isMobile}>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
        resizable={{
          minWidth: isMobile ? THREAD_SIDEBAR_MIN_WIDTH_MOBILE : THREAD_SIDEBAR_MIN_WIDTH_DESKTOP,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth >=
            (isMobile
              ? THREAD_MAIN_CONTENT_MIN_WIDTH_MOBILE
              : THREAD_MAIN_CONTENT_MIN_WIDTH_DESKTOP),
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <ThreadSidebar />
        <SidebarRail />
      </Sidebar>
      {children}
    </SidebarProvider>
  );
}
