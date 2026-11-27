/**
 * tasks-app UI. Routes match SDK_ROUTE_PATTERNS (hostRouting.tsx); the route
 * chip in the top bar and the host URL always show the same path.
 */
import { useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router";
import { readBoot, type HostApi } from "@vibe/plugin-contracts/sdk";
import { HostRouter, type HostRouting } from "./hostRouting";
import { normalizeData, STORAGE_KEY, type Project, type Task, type TasksData } from "./data";

type Filter = "all" | "open" | "done";

interface AppProps {
  host: HostApi;
  routing: HostRouting;
}

export function App({ host, routing }: AppProps) {
  const [data, setData] = useState<TasksData | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void host.storage
      .get(STORAGE_KEY)
      .then((value) => {
        if (alive) setData(normalizeData(value));
      })
      .catch(() => {
        if (alive) setData(normalizeData(undefined));
      });
    return () => {
      alive = false;
    };
  }, [host]);

  if (data === undefined) {
    return <div className="app-loading">Loading tasks…</div>;
  }

  const update = (next: TasksData): void => {
    setData(next);
    void host.storage.set(STORAGE_KEY, next).catch(() => {
      void host.notify.show({ level: "error", message: "Could not save tasks" });
    });
  };
  const toggleTask = (id: string): void => {
    update({ ...data, tasks: data.tasks.map((task) => (task.id === id ? { ...task, done: !task.done } : task)) });
  };
  const removeTask = (id: string): void => {
    const task = data.tasks.find((candidate) => candidate.id === id);
    update({ ...data, tasks: data.tasks.filter((candidate) => candidate.id !== id) });
    void host.notify.show({ level: "info", message: `Task "${task?.title ?? id}" deleted` });
  };
  const addTask = (title: string, projectId: string): void => {
    const id = `t${Date.now().toString(36)}`;
    update({ ...data, tasks: [...data.tasks, { id, title, done: false, projectId }] });
  };

  const operations = { update, toggleTask, removeTask, addTask };

  return (
    <HostRouter routing={routing}>
      <div className="app-shell">
        <aside className="app-side">
          <div className="app-brand">Tasks</div>
          <nav className="app-nav">
            <NavLink to="/" end className={({ isActive }) => (isActive ? "is-active" : "")}>
              Overview
            </NavLink>
            <NavLink to="/tasks" end className={({ isActive }) => (isActive ? "is-active" : "")}>
              Tasks
            </NavLink>
            <NavLink to="/projects" className={({ isActive }) => (isActive ? "is-active" : "")}>
              Projects
            </NavLink>
            <NavLink to="/about" className={({ isActive }) => (isActive ? "is-active" : "")}>
              About
            </NavLink>
          </nav>
        </aside>
        <div className="app-main">
          <header className="app-top">
            <RouteChip />
          </header>
          <main className="app-content">
            <Routes>
              <Route path="/" element={<Overview data={data} />} />
              <Route path="/tasks" element={<TasksPage data={data} filter="all" operations={operations} projects={data.projects} />} />
              <Route path="/tasks/:filter" element={<FilterRoute data={data} operations={operations} projects={data.projects} />} />
              <Route path="/task/:taskId" element={<TaskPage data={data} operations={operations} projects={data.projects} />} />
              <Route path="/projects" element={<ProjectsPage data={data} />} />
              <Route path="/projects/:projectId" element={<ProjectPage data={data} operations={operations} projects={data.projects} />} />
              <Route path="/about" element={<AboutPage host={host} />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </main>
        </div>
      </div>
    </HostRouter>
  );
}

/** The path this frame is routed at, as the host URL shows it. */
function RouteChip() {
  const location = useLocation();
  return <span className="app-route">{location.pathname}</span>;
}

function Overview({ data }: { data: TasksData }) {
  const open = data.tasks.filter((task) => !task.done).length;
  const done = data.tasks.length - open;
  const firstOpen = data.tasks.find((task) => !task.done);
  return (
    <section>
      <h1>Overview</h1>
      <div className="card-row">
        <div className="card">
          <div className="card-value">{data.tasks.length}</div>
          <div className="card-label">tasks total</div>
        </div>
        <div className="card">
          <div className="card-value">{open}</div>
          <div className="card-label">open</div>
        </div>
        <div className="card">
          <div className="card-value">{done}</div>
          <div className="card-label">done</div>
        </div>
        <div className="card">
          <div className="card-value">{data.projects.length}</div>
          <div className="card-label">projects</div>
        </div>
      </div>
      <p className="hint">
        {firstOpen === undefined ? (
          "Everything is done. Add a new task on the Tasks page."
        ) : (
          <>
            Next up: <Link to={`/task/${firstOpen.id}`}>{firstOpen.title}</Link>
          </>
        )}
      </p>
    </section>
  );
}

function FilterRoute({
  data,
  operations,
  projects,
}: {
  data: TasksData;
  operations: Operations;
  projects: Project[];
}) {
  const params = useParams();
  const filter = params.filter === "open" || params.filter === "done" ? params.filter : undefined;
  // Unknown filter words normalize to the plain list; replace keeps the host URL in step.
  if (filter === undefined) return <Navigate to="/tasks" replace />;
  return <TasksPage data={data} filter={filter} operations={operations} projects={projects} />;
}

interface Operations {
  update(next: TasksData): void;
  toggleTask(id: string): void;
  removeTask(id: string): void;
  addTask(title: string, projectId: string): void;
}

function TasksPage({
  data,
  filter,
  operations,
  projects,
}: {
  data: TasksData;
  filter: Filter;
  operations: Operations;
  projects: Project[];
}) {
  const [draft, setDraft] = useState("");
  const visible = data.tasks.filter((task) => (filter === "all" ? true : filter === "done" ? task.done : !task.done));

  const submit = (): void => {
    const title = draft.trim();
    if (title === "") return;
    operations.addTask(title, projects[0]?.id ?? "");
    setDraft("");
  };

  return (
    <section>
      <h1>Tasks</h1>
      <nav className="chip-row" aria-label="Filters">
        <NavLink to="/tasks" end className={({ isActive }) => (isActive ? "chip is-active" : "chip")}>
          All
        </NavLink>
        <NavLink to="/tasks/open" className={({ isActive }) => (isActive ? "chip is-active" : "chip")}>
          Open
        </NavLink>
        <NavLink to="/tasks/done" className={({ isActive }) => (isActive ? "chip is-active" : "chip")}>
          Done
        </NavLink>
      </nav>
      <div className="task-list">
        {visible.length === 0 ? (
          <p className="hint">No tasks here yet.</p>
        ) : (
          visible.map((task) => <TaskRow key={task.id} task={task} projects={projects} operations={operations} />)
        )}
      </div>
      <form
        className="task-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          type="text"
          value={draft}
          placeholder="A new task"
          aria-label="new task"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="btn">
          Add task
        </button>
      </form>
    </section>
  );
}

function TaskRow({
  task,
  projects,
  operations,
}: {
  task: Task;
  projects: Project[];
  operations: Operations;
}) {
  const project = projects.find((candidate) => candidate.id === task.projectId);
  return (
    <div className={`task-row${task.done ? " is-done" : ""}`}>
      <input
        type="checkbox"
        aria-label={`task ${task.title}`}
        checked={task.done}
        onChange={() => operations.toggleTask(task.id)}
      />
      <Link to={`/task/${task.id}`} className="task-title">
        {task.title}
      </Link>
      {project === undefined ? null : (
        <Link to={`/projects/${project.id}`} className="chip chip-mono">
          {project.title}
        </Link>
      )}
    </div>
  );
}

function TaskPage({
  data,
  operations,
  projects,
}: {
  data: TasksData;
  operations: Operations;
  projects: Project[];
}) {
  const params = useParams();
  const navigate = useNavigate();
  const task = data.tasks.find((candidate) => candidate.id === params.taskId);
  if (task === undefined) {
    return (
      <section>
        <h1>Unknown task</h1>
        <p className="hint">
          No task with id <code>{params.taskId}</code>. <Link to="/tasks">Back to the list.</Link>
        </p>
      </section>
    );
  }
  const project = projects.find((candidate) => candidate.id === task.projectId);
  return (
    <section>
      <h1>{task.title}</h1>
      <dl className="meta">
        <dt>Status</dt>
        <dd>{task.done ? "Done" : "Open"}</dd>
        <dt>Project</dt>
        <dd>
          {project === undefined ? "—" : <Link to={`/projects/${project.id}`}>{project.title}</Link>}
        </dd>
      </dl>
      <div className="btn-row">
        <button type="button" className="btn" onClick={() => operations.toggleTask(task.id)}>
          Toggle status
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            operations.removeTask(task.id);
            navigate("/tasks", { replace: true });
          }}
        >
          Delete task
        </button>
      </div>
    </section>
  );
}

function ProjectsPage({ data }: { data: TasksData }) {
  return (
    <section>
      <h1>Projects</h1>
      <div className="card-row">
        {data.projects.map((project) => {
          const tasks = data.tasks.filter((task) => task.projectId === project.id);
          const open = tasks.filter((task) => !task.done).length;
          return (
            <Link key={project.id} to={`/projects/${project.id}`} className="card">
              <div className="card-value">{tasks.length}</div>
              <div className="card-label">{project.title}</div>
              <div className="card-note">{open} open</div>
            </Link>
          );
        })}
        {data.projects.length === 0 ? <p className="hint">No projects.</p> : null}
      </div>
    </section>
  );
}

function ProjectPage({
  data,
  operations,
  projects,
}: {
  data: TasksData;
  operations: Operations;
  projects: Project[];
}) {
  const params = useParams();
  const project = data.projects.find((candidate) => candidate.id === params.projectId);
  if (project === undefined) {
    return (
      <section>
        <h1>Unknown project</h1>
        <p className="hint">
          No project with id <code>{params.projectId}</code>. <Link to="/projects">Back to the list.</Link>
        </p>
      </section>
    );
  }
  const tasks = data.tasks.filter((task) => task.projectId === project.id);
  return (
    <section>
      <h1>{project.title}</h1>
      <div className="task-list">
        {tasks.length === 0 ? (
          <p className="hint">No tasks in this project.</p>
        ) : (
          tasks.map((task) => <TaskRow key={task.id} task={task} projects={projects} operations={operations} />)
        )}
      </div>
    </section>
  );
}

function AboutPage({ host }: { host: HostApi }) {
  const [hostVersion, setHostVersion] = useState("…");
  useEffect(() => {
    let alive = true;
    void host.context
      .get()
      .then((context) => {
        if (alive) setHostVersion(context.hostVersion);
      })
      .catch(() => {
        if (alive) setHostVersion("unavailable");
      });
    return () => {
      alive = false;
    };
  }, [host]);
  const boot = readBoot();
  return (
    <section>
      <h1>About</h1>
      <dl className="meta">
        <dt>Plugin</dt>
        <dd>
          {boot.id} {boot.version}
        </dd>
        <dt>SDK</dt>
        <dd>{boot.sdk}</dd>
        <dt>hostAPI</dt>
        <dd>{boot.hostApiMajor}</dd>
        <dt>Host version</dt>
        <dd>{hostVersion}</dd>
        <dt>Routing</dt>
        <dd>react-router on the host's virtual URL space</dd>
      </dl>
    </section>
  );
}

function NotFoundPage() {
  const location = useLocation();
  return (
    <section>
      <h1>404</h1>
      <p className="hint">
        No route for <code>{location.pathname}</code>. <Link to="/">Back to the overview.</Link>
      </p>
    </section>
  );
}
