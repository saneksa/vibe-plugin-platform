/** Tasks and projects, persisted through the instance-scoped host.storage. */

export interface Task {
  id: string;
  title: string;
  done: boolean;
  projectId: string;
}

export interface Project {
  id: string;
  title: string;
}

export interface TasksData {
  tasks: Task[];
  projects: Project[];
}

export const STORAGE_KEY = "tasks";

export function seedData(): TasksData {
  return {
    projects: [
      { id: "website", title: "Website" },
      { id: "api", title: "API" },
    ],
    tasks: [
      { id: "t1", title: "Design the landing page", done: true, projectId: "website" },
      { id: "t2", title: "Write the hero copy", done: false, projectId: "website" },
      { id: "t3", title: "Wire the contact form", done: false, projectId: "website" },
      { id: "t4", title: "Sketch the endpoints", done: true, projectId: "api" },
      { id: "t5", title: "Add pagination to the task list", done: false, projectId: "api" },
      { id: "t6", title: "Set up continuous integration", done: false, projectId: "api" },
    ],
  };
}

/** First run seeds; an empty-but-valid store is kept (everything may be deleted). */
export function normalizeData(value: unknown): TasksData {
  if (typeof value !== "object" || value === null) return seedData();
  const { tasks, projects } = value as { tasks?: unknown; projects?: unknown };
  if (!Array.isArray(tasks) || !Array.isArray(projects)) return seedData();

  const validTasks = tasks.filter(
    (task): task is Task =>
      typeof (task as Task)?.id === "string" &&
      typeof (task as Task)?.title === "string" &&
      typeof (task as Task)?.done === "boolean" &&
      typeof (task as Task)?.projectId === "string",
  );
  const validProjects = projects.filter(
    (project): project is Project =>
      typeof (project as Project)?.id === "string" && typeof (project as Project)?.title === "string",
  );
  return { tasks: validTasks, projects: validProjects };
}
