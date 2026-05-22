import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface NewIssueDefaults {
  draftId?: string;
  parentId?: string;
  parentIssue?: {
    id: string;
    identifier?: string | null;
    title?: string | null;
  };
  status?: string;
  priority?: string;
  projectId?: string;
  labelIds?: string[];
  assigneeAgentId?: string;
  assigneeUserId?: string;
  reviewerAgentId?: string;
  reviewerUserId?: string;
  title?: string;
  description?: string;
}

interface NewGoalDefaults {
  parentId?: string;
}

interface OnboardingOptions {
  initialStep?: 1 | 2 | 3 | 4;
  orgId?: string;
}

interface ProductTourOptions {
  source?: "auto" | "settings";
}

export interface ConfirmDialogOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "destructive";
}

export interface PromptTextDialogOptions {
  title: string;
  description?: ReactNode;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

type ConfirmDialogRequest = ConfirmDialogOptions & {
  id: number;
  resolve: (confirmed: boolean) => void;
};

type PromptTextDialogRequest = PromptTextDialogOptions & {
  id: number;
  resolve: (value: string | null) => void;
};

interface DialogContextValue {
  newIssueOpen: boolean;
  newIssueDefaults: NewIssueDefaults;
  openNewIssue: (defaults?: NewIssueDefaults) => void;
  closeNewIssue: () => void;
  newProjectOpen: boolean;
  openNewProject: () => void;
  closeNewProject: () => void;
  newGoalOpen: boolean;
  newGoalDefaults: NewGoalDefaults;
  openNewGoal: (defaults?: NewGoalDefaults) => void;
  closeNewGoal: () => void;
  newAgentOpen: boolean;
  openNewAgent: () => void;
  closeNewAgent: () => void;
  onboardingOpen: boolean;
  onboardingOptions: OnboardingOptions;
  openOnboarding: (options?: OnboardingOptions) => void;
  closeOnboarding: () => void;
  productTourOpen: boolean;
  productTourOptions: ProductTourOptions;
  openProductTour: (options?: ProductTourOptions) => void;
  closeProductTour: () => void;
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  promptText: (options: PromptTextDialogOptions) => Promise<string | null>;
}

const DialogContext = createContext<DialogContextValue | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  const [newIssueDefaults, setNewIssueDefaults] = useState<NewIssueDefaults>({});
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newGoalOpen, setNewGoalOpen] = useState(false);
  const [newGoalDefaults, setNewGoalDefaults] = useState<NewGoalDefaults>({});
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingOptions, setOnboardingOptions] = useState<OnboardingOptions>({});
  const [productTourOpen, setProductTourOpen] = useState(false);
  const [productTourOptions, setProductTourOptions] = useState<ProductTourOptions>({});
  const [confirmRequest, setConfirmRequest] = useState<ConfirmDialogRequest | null>(null);
  const [promptTextRequest, setPromptTextRequest] = useState<PromptTextDialogRequest | null>(null);
  const [promptTextValue, setPromptTextValue] = useState("");
  const confirmRequestRef = useRef<ConfirmDialogRequest | null>(null);
  const promptTextRequestRef = useRef<PromptTextDialogRequest | null>(null);
  const dialogRequestIdRef = useRef(0);

  const openNewIssue = useCallback((defaults: NewIssueDefaults = {}) => {
    setNewIssueDefaults(defaults);
    setNewIssueOpen(true);
  }, []);

  const closeNewIssue = useCallback(() => {
    setNewIssueOpen(false);
    setNewIssueDefaults({});
  }, []);

  const openNewProject = useCallback(() => {
    setNewProjectOpen(true);
  }, []);

  const closeNewProject = useCallback(() => {
    setNewProjectOpen(false);
  }, []);

  const openNewGoal = useCallback((defaults: NewGoalDefaults = {}) => {
    setNewGoalDefaults(defaults);
    setNewGoalOpen(true);
  }, []);

  const closeNewGoal = useCallback(() => {
    setNewGoalOpen(false);
    setNewGoalDefaults({});
  }, []);

  const openNewAgent = useCallback(() => {
    setNewAgentOpen(true);
  }, []);

  const closeNewAgent = useCallback(() => {
    setNewAgentOpen(false);
  }, []);

  const openOnboarding = useCallback((options: OnboardingOptions = {}) => {
    setOnboardingOptions(options);
    setOnboardingOpen(true);
  }, []);

  const closeOnboarding = useCallback(() => {
    setOnboardingOpen(false);
    setOnboardingOptions({});
  }, []);

  const openProductTour = useCallback((options: ProductTourOptions = {}) => {
    setProductTourOptions(options);
    setProductTourOpen(true);
  }, []);

  const closeProductTour = useCallback(() => {
    setProductTourOpen(false);
    setProductTourOptions({});
  }, []);

  const confirm = useCallback((options: ConfirmDialogOptions) => (
    new Promise<boolean>((resolve) => {
      dialogRequestIdRef.current += 1;
      setConfirmRequest({
        id: dialogRequestIdRef.current,
        resolve,
        ...options,
      });
    })
  ), []);

  const promptText = useCallback((options: PromptTextDialogOptions) => (
    new Promise<string | null>((resolve) => {
      dialogRequestIdRef.current += 1;
      setPromptTextRequest({
        id: dialogRequestIdRef.current,
        resolve,
        ...options,
      });
    })
  ), []);

  const settleConfirm = useCallback((confirmed: boolean) => {
    const current = confirmRequestRef.current;
    if (!current) return;
    confirmRequestRef.current = null;
    current.resolve(confirmed);
    setConfirmRequest(null);
  }, []);

  const settlePromptText = useCallback((value: string | null) => {
    const current = promptTextRequestRef.current;
    if (!current) return;
    promptTextRequestRef.current = null;
    current.resolve(value);
    setPromptTextRequest(null);
  }, []);

  useEffect(() => {
    confirmRequestRef.current = confirmRequest;
  }, [confirmRequest]);

  useEffect(() => {
    promptTextRequestRef.current = promptTextRequest;
  }, [promptTextRequest]);

  useEffect(() => {
    setPromptTextValue(promptTextRequest?.defaultValue ?? "");
  }, [promptTextRequest?.id, promptTextRequest?.defaultValue]);

  return (
    <DialogContext.Provider
      value={{
        newIssueOpen,
        newIssueDefaults,
        openNewIssue,
        closeNewIssue,
        newProjectOpen,
        openNewProject,
        closeNewProject,
        newGoalOpen,
        newGoalDefaults,
        openNewGoal,
        closeNewGoal,
        newAgentOpen,
        openNewAgent,
        closeNewAgent,
        onboardingOpen,
        onboardingOptions,
        openOnboarding,
        closeOnboarding,
        productTourOpen,
        productTourOptions,
        openProductTour,
        closeProductTour,
        confirm,
        promptText,
      }}
    >
      {children}
      <Dialog
        open={confirmRequest !== null}
        onOpenChange={(open) => {
          if (!open) settleConfirm(false);
        }}
      >
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-base leading-6">
              {confirmRequest?.title}
            </DialogTitle>
            {confirmRequest?.description ? (
              <DialogDescription>
                {confirmRequest.description}
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => settleConfirm(false)}>
              {confirmRequest?.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              type="button"
              variant={confirmRequest?.tone === "destructive" ? "destructive" : "default"}
              onClick={() => settleConfirm(true)}
            >
              {confirmRequest?.confirmLabel ?? "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={promptTextRequest !== null}
        onOpenChange={(open) => {
          if (!open) settlePromptText(null);
        }}
      >
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              settlePromptText(promptTextValue.trim());
            }}
          >
            <DialogHeader>
              <DialogTitle className="text-base leading-6">
                {promptTextRequest?.title}
              </DialogTitle>
              {promptTextRequest?.description ? (
                <DialogDescription>
                  {promptTextRequest.description}
                </DialogDescription>
              ) : null}
            </DialogHeader>
            <div className="space-y-1.5">
              {promptTextRequest?.label ? (
                <Label htmlFor="app-prompt-text-input">{promptTextRequest.label}</Label>
              ) : null}
              <Input
                id="app-prompt-text-input"
                autoFocus
                value={promptTextValue}
                placeholder={promptTextRequest?.placeholder}
                onChange={(event) => setPromptTextValue(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => settlePromptText(null)}>
                {promptTextRequest?.cancelLabel ?? "Cancel"}
              </Button>
              <Button type="submit">
                {promptTextRequest?.confirmLabel ?? "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </DialogContext.Provider>
  );
}

export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error("useDialog must be used within DialogProvider");
  }
  return ctx;
}
