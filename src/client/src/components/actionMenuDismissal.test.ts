import { LitElement } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectList } from "./ProjectList";
import { SessionList } from "./SessionList";
import { WorkspaceList } from "./WorkspaceList";
import { actionMenuDocumentClickEvent, actionMenuDocumentClickListener, dispatchActionMenuDocumentClick } from "./actionMenu.testSupport";

interface ActionMenuList extends EventTarget {
  connectedCallback(): void;
}

interface ActionMenuListFixture {
  name: string;
  create(): ActionMenuList;
  openMenuState: string;
}

const menuListFixtures: readonly ActionMenuListFixture[] = [
  { name: "session", create: () => new SessionList(), openMenuState: "openMenuSessionId" },
  { name: "project", create: () => new ProjectList(), openMenuState: "openMenuProjectId" },
  { name: "workspace", create: () => new WorkspaceList(), openMenuState: "openMenuWorkspaceId" },
];

describe("action menu dismissal listeners", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  for (const fixture of menuListFixtures) {
    it(`registers the ${fixture.name} menu listener during click capture before stopped controls`, () => {
      const addEventListener = vi.fn();
      vi.stubGlobal("document", { addEventListener, removeEventListener: vi.fn() });
      vi.spyOn(LitElement.prototype, "connectedCallback").mockImplementation(() => undefined);

      const list = fixture.create();
      Reflect.set(list, fixture.openMenuState, "open-menu");
      list.connectedCallback();

      const listener = actionMenuDocumentClickListener(list);
      expect(addEventListener).toHaveBeenCalledWith("click", listener, true);

      const click = actionMenuDocumentClickEvent([list]);
      // A document capture listener runs before an outside control stops bubbling.
      listener(click);
      click.stopPropagation();

      expect(Reflect.get(list, fixture.openMenuState)).toBeUndefined();
    });

    it(`keeps the ${fixture.name} menu open when clicked`, () => {
      vi.stubGlobal("HTMLElement", FakeActionMenuElement);
      const list = fixture.create();
      const renderRoot = new EventTarget();
      Reflect.set(list, "renderRoot", renderRoot);
      Reflect.set(list, fixture.openMenuState, "open-menu");

      dispatchActionMenuDocumentClick(list, [new FakeActionMenuElement(renderRoot)]);

      expect(Reflect.get(list, fixture.openMenuState)).toBe("open-menu");
    });

    it(`dismisses the ${fixture.name} menu when another component menu is clicked`, () => {
      vi.stubGlobal("HTMLElement", FakeActionMenuElement);
      const list = fixture.create();
      Reflect.set(list, "renderRoot", new EventTarget());
      Reflect.set(list, fixture.openMenuState, "open-menu");

      dispatchActionMenuDocumentClick(list, [new FakeActionMenuElement(new EventTarget())]);

      expect(Reflect.get(list, fixture.openMenuState)).toBeUndefined();
    });
  }
});

class FakeActionMenuElement extends EventTarget {
  constructor(private readonly root: EventTarget) {
    super();
  }

  getRootNode(): EventTarget {
    return this.root;
  }

  closest(selector: string): FakeActionMenuElement | null {
    return selector === ".action-menu" ? this : null;
  }
}
