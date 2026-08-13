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
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

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
  goalId?: string;
  labelIds?: string[];
  assigneeAgentId?: string;
  assigneeUserId?: string;
  reviewerAgentId?: string;
  reviewerUserId?: string;
  title?: string;
  description?: string;
}

export interface NewGoalDefaults {
  parentId?: string;
  draftId?: string;
  title?: string;
  context?: string;
  ownerAgentId?: string;
  targetTime?: string;
}

interface OnboardingOptions {
  initialStep?: 1 | 2;
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
  restoreFocus?: (confirmed: boolean) => void;
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
  returnFocus: HTMLElement | null;
};

type PromptTextDialogRequest = PromptTextDialogOptions & {
  id: number;
  resolve: (value: string | null) => void;
  returnFocus: HTMLElement | null;
};

type SettledConfirmDialogRequest = {
  request: ConfirmDialogRequest;
  confirmed: boolean;
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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [promptTextRequest, setPromptTextRequest] = useState<PromptTextDialogRequest | null>(null);
  const [promptTextOpen, setPromptTextOpen] = useState(false);
  const [promptTextValue, setPromptTextValue] = useState("");
  const confirmRequestRef = useRef<ConfirmDialogRequest | null>(null);
  const promptTextRequestRef = useRef<PromptTextDialogRequest | null>(null);
  const settledConfirmRequestRef = useRef<SettledConfirmDialogRequest | null>(null);
  const settledPromptTextRequestRef = useRef<PromptTextDialogRequest | null>(null);
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
      const request: ConfirmDialogRequest = {
        id: dialogRequestIdRef.current,
        resolve,
        returnFocus: document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
        ...options,
      };
      confirmRequestRef.current = request;
      setConfirmRequest(request);
      setConfirmOpen(true);
    })
  ), []);

  const promptText = useCallback((options: PromptTextDialogOptions) => (
    new Promise<string | null>((resolve) => {
      dialogRequestIdRef.current += 1;
      const request: PromptTextDialogRequest = {
        id: dialogRequestIdRef.current,
        resolve,
        returnFocus: document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
        ...options,
      };
      promptTextRequestRef.current = request;
      setPromptTextRequest(request);
      setPromptTextOpen(true);
    })
  ), []);

  const settleConfirm = useCallback((confirmed: boolean) => {
    const current = confirmRequestRef.current;
    if (!current) return;
    confirmRequestRef.current = null;
    settledConfirmRequestRef.current = { request: current, confirmed };
    current.resolve(confirmed);
    setConfirmOpen(false);
  }, []);

  const settlePromptText = useCallback((value: string | null) => {
    const current = promptTextRequestRef.current;
    if (!current) return;
    promptTextRequestRef.current = null;
    settledPromptTextRequestRef.current = current;
    current.resolve(value);
    setPromptTextOpen(false);
  }, []);

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
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) settleConfirm(false);
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const settled = settledConfirmRequestRef.current;
            if (!settled) return;
            settledConfirmRequestRef.current = null;
            setConfirmRequest((current) => current?.id === settled.request.id ? null : current);
            if (confirmRequestRef.current) return;
            const { restoreFocus } = settled.request;
            if (restoreFocus) {
              restoreFocus(settled.confirmed);
              return;
            }
            if (settled.request.returnFocus?.isConnected) {
              settled.request.returnFocus.focus({ preventScroll: true });
            }
          }}
        >
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
        open={promptTextOpen}
        onOpenChange={(open) => {
          if (!open) settlePromptText(null);
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const settled = settledPromptTextRequestRef.current;
            if (!settled) return;
            settledPromptTextRequestRef.current = null;
            setPromptTextRequest((current) => current?.id === settled.id ? null : current);
            if (promptTextRequestRef.current) return;
            if (settled.returnFocus?.isConnected) settled.returnFocus.focus({ preventScroll: true });
          }}
        >
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
