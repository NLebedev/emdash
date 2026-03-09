import React from 'react';
import ChatInterface from './ChatInterface';
import MultiAgentTask from './MultiAgentTask';
import ProjectMainView from './ProjectMainView';
import HomeView from './HomeView';
import SkillsView from './skills/SkillsView';
import { McpPage } from './mcp/McpPage';
import { SettingsPage, type SettingsPageTab } from './SettingsPage';
import TaskCreationLoading from './TaskCreationLoading';
import TaskGridView from './TaskGridView';
import { useProjectManagementContext } from '../contexts/ProjectManagementProvider';
import { useTaskManagementContext } from '../contexts/TaskManagementContext';
import { useProjectRemoteInfo } from '../hooks/useProjectRemoteInfo';

interface MainContentAreaProps {
  showSettingsPage: boolean;
  settingsPageInitialTab?: SettingsPageTab;
  handleCloseSettingsPage?: () => void;
}

const MainContentArea: React.FC<MainContentAreaProps> = ({
  showSettingsPage,
  settingsPageInitialTab,
  handleCloseSettingsPage,
}) => {
  const { connectionId: projectRemoteConnectionId, remotePath: projectRemotePath } =
    useProjectRemoteInfo();
  const {
    projects,
    selectedProject,
    showHomeView,
    showSkillsView,
    showMcpView,
    showKanban,
    setShowKanban,
    showTaskGrid,
    setShowTaskGrid,
    projectDefaultBranch,
    projectBranchOptions,
    isLoadingBranches,
    setProjectDefaultBranch,
    handleDeleteProject,
    handleOpenProject,
    handleNewProjectClick,
    handleCloneProjectClick,
    handleAddRemoteProject,
    handleSelectProject,
  } = useProjectManagementContext();
  const {
    activeTask,
    activeTaskAgent,
    isCreatingTask,
    handleTaskInterfaceReady: onTaskInterfaceReady,
    openTaskModal,
    handleSelectTask,
    handleDeleteTask,
    handleArchiveTask,
    handleRestoreTask,
    handleRenameTask: onRenameTask,
  } = useTaskManagementContext();

  if (showSettingsPage) {
    return (
      <div className="relative z-10 flex min-h-0 flex-1 overflow-hidden bg-background">
        <SettingsPage
          initialTab={settingsPageInitialTab}
          onClose={handleCloseSettingsPage || (() => {})}
        />
      </div>
    );
  }

  if (showHomeView) {
    return (
      <HomeView
        onOpenProject={handleOpenProject}
        onNewProjectClick={handleNewProjectClick}
        onCloneProjectClick={handleCloneProjectClick}
        onAddRemoteProject={handleAddRemoteProject}
      />
    );
  }

  if (showSkillsView) {
    return <SkillsView />;
  }

  if (showMcpView) {
    return <McpPage />;
  }

  if (selectedProject) {
    const singleView = activeTask ? (
      (activeTask.metadata as any)?.multiAgent?.enabled ? (
        <MultiAgentTask
          task={activeTask}
          projectName={selectedProject.name}
          projectId={selectedProject.id}
          projectPath={selectedProject.path}
          projectRemoteConnectionId={projectRemoteConnectionId}
          projectRemotePath={projectRemotePath}
          defaultBranch={projectDefaultBranch}
          onTaskInterfaceReady={onTaskInterfaceReady}
        />
      ) : (
        <ChatInterface
          task={activeTask}
          project={selectedProject}
          projectName={selectedProject.name}
          projectPath={selectedProject.path}
          projectRemoteConnectionId={projectRemoteConnectionId}
          projectRemotePath={projectRemotePath}
          defaultBranch={projectDefaultBranch}
          className="min-h-0 flex-1"
          initialAgent={activeTaskAgent || undefined}
          onTaskInterfaceReady={onTaskInterfaceReady}
          onRenameTask={onRenameTask}
          fullWidth={!showTaskGrid}
        />
      )
    ) : (
      <ProjectMainView
        project={selectedProject}
        onCreateTask={() => openTaskModal()}
        activeTask={activeTask}
        onSelectTask={handleSelectTask}
        onDeleteTask={handleDeleteTask}
        onArchiveTask={handleArchiveTask}
        onRestoreTask={handleRestoreTask}
        onDeleteProject={handleDeleteProject}
        branchOptions={projectBranchOptions}
        isLoadingBranches={isLoadingBranches}
        onBaseBranchChange={setProjectDefaultBranch}
      />
    );

    return (
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <TaskGridView
          project={selectedProject}
          projects={projects}
          activeTask={activeTask}
          isGridEnabled={showTaskGrid}
          onGridEnabledChange={setShowTaskGrid}
          singleView={singleView}
          onSelectTaskInProject={(project, task) => {
            if (selectedProject.id !== project.id) {
              handleSelectProject(project);
            }
            handleSelectTask(task);
          }}
          onOpenTaskInProject={(project, task) => {
            if (selectedProject.id !== project.id) {
              handleSelectProject(project);
            }
            handleSelectTask(task);
            setShowTaskGrid(false);
          }}
          onCreateTaskForProject={(project) => {
            if (selectedProject.id !== project.id) {
              handleSelectProject(project);
            }
            openTaskModal();
          }}
          projectRemoteConnectionId={projectRemoteConnectionId}
          defaultBranch={projectDefaultBranch}
        />

        {isCreatingTask && (
          <div className="absolute inset-0 z-10 bg-background">
            <TaskCreationLoading />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-background text-muted-foreground">
      <div className="text-center">
        <h3 className="text-lg font-medium">No project selected</h3>
        <p className="mt-1">Select a project from the sidebar to get started.</p>
      </div>
    </div>
  );
};

export default MainContentArea;
