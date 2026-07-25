import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Project } from "./api";

const STORAGE_KEY = "zerobug.currentProjectId";

interface ProjectContextValue {
  projects: Project[];
  isLoading: boolean;
  isError: boolean;
  currentProjectId: string | null;
  currentProject: Project | null;
  setProjectId: (id: string) => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { data: projects = [], isLoading, isError } = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects,
  });
  const [selected, setSelected] = useState<string | null>(null);

  // Hydrate the last-used project from localStorage (client only).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) setSelected(saved);
  }, []);

  // Resolve to a valid selection, falling back to the first project.
  const resolvedId =
    selected && projects.some((p) => p.id === selected) ? selected : (projects[0]?.id ?? null);

  const setProjectId = (id: string) => {
    setSelected(id);
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, id);
  };

  const currentProject = projects.find((p) => p.id === resolvedId) ?? null;

  return (
    <ProjectContext.Provider
      value={{
        projects,
        isLoading,
        isError,
        currentProjectId: resolvedId,
        currentProject,
        setProjectId,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject() {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProject must be used within a ProjectProvider");
  return ctx;
}
