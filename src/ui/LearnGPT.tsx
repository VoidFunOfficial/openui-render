"use client";
import { useEffect, useState } from "react";
import { defaultProjectId } from "@/shared/projects";
import { WorkspaceApp } from "./WorkspaceApp";

export function LearnGPT() {
  const [projectId, setProjectId] = useState("");
  useEffect(() => {
    const route = () => {
      const url = new URL(location.href);
      let next = url.searchParams.get("project");
      if (!next) {
        // A legacy chat bookmark belongs to the default project.
        if (!url.hash) {
          try { next = localStorage.getItem("learngpt:project"); } catch { /* private browsing */ }
        }
        next ||= defaultProjectId;
        url.searchParams.set("project", next);
        history.replaceState(history.state, "", url);
      }
      setProjectId(next);
    };
    route();
    window.addEventListener("popstate", route);
    return () => window.removeEventListener("popstate", route);
  }, []);
  useEffect(() => {
    if (projectId) {
      try { localStorage.setItem("learngpt:project", projectId); } catch { /* private browsing */ }
    }
  }, [projectId]);
  function switchProject(id: string) {
    if (id === projectId) return;
    history.pushState(null, "", "?project=" + id);
    setProjectId(id);
  }
  if (!projectId) return <div className="app-loading" role="status">LearnGPT</div>;
  return <WorkspaceApp key={projectId} projectId={projectId} switchProject={switchProject} />;
}
