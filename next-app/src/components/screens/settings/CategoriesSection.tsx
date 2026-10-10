"use client";

import { useId, useState } from "react";
import { LIMITS, type CategoryGroup } from "@/domain/schema";
import { useSnapshot } from "@/client/react";
import { useDispatch } from "../../app/hooks";
import { Button } from "../../ui/Button";
import { useToast } from "../../ui/feedback";
import { controlClass } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { SectionCard } from "./SettingsList";

const GROUPS: { group: CategoryGroup; title: string; hint: string }[] = [
  { group: "income", title: "Доходы", hint: "зарплата, аванс, подработка" },
  { group: "mandatory", title: "Обязательные", hint: "аренда, кредиты, связь, крупные покупки" },
  { group: "flexible", title: "Повседневные", hint: "продукты, кафе, транспорт" },
];

export function CategoriesSection() {
  return (
    <SectionCard title="Категории">
      <p className="text-sm text-muted">
        Удаление категории не меняет прошлые операции — они сохранят свою категорию. Новую категорию можно добавить и
        прямо при вводе операции.
      </p>
      <div className="mt-4 space-y-6">
        {GROUPS.map((g) => (
          <CategoryGroupEditor key={g.group} group={g.group} title={g.title} hint={g.hint} />
        ))}
      </div>
    </SectionCard>
  );
}

function CategoryGroupEditor({ group, title, hint }: { group: CategoryGroup; title: string; hint: string }) {
  const { state } = useSnapshot();
  const dispatch = useDispatch();
  const toast = useToast();
  const headingId = useId();
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const list = state.categories[group];

  const add = () => {
    const name = draft.trim();
    if (!name) return;
    if (dispatch({ type: "category.add", group, name })) setDraft("");
  };

  const remove = (name: string) => {
    if (!dispatch({ type: "category.remove", group, name })) return;
    toast(`Категория «${name}» удалена`, {
      action: { label: "Вернуть", onClick: () => dispatch({ type: "category.add", group, name }) },
    });
  };

  return (
    <section aria-labelledby={headingId} className="space-y-2.5">
      <div>
        <h3 id={headingId} className="text-[15px] font-medium">
          {title}
        </h3>
        <p className="text-xs text-muted">Например, {hint}</p>
      </div>

      {list.length ? (
        <ul className="flex flex-wrap gap-2">
          {list.map((name) => (
            <li
              key={name}
              className="inline-flex h-10 max-w-full items-center rounded-full border border-border bg-surface-2 pl-3.5 text-sm"
            >
              <span className="min-w-0 truncate">{name}</span>
              <button
                type="button"
                aria-label={`Удалить категорию «${name}»`}
                title="Удалить"
                onClick={() => remove(name)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted transition hover:text-negative"
              >
                <Icon name="close" size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Категорий нет.</p>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Новая категория в группе «{title}»
        </label>
        <input
          id={inputId}
          value={draft}
          maxLength={LIMITS.category}
          placeholder="Новая категория"
          autoComplete="off"
          enterKeyHint="done"
          onChange={(e) => setDraft(e.target.value)}
          className={`${controlClass} h-11 min-w-0 flex-1`}
        />
        <Button type="submit" variant="secondary" icon="plus" disabled={!draft.trim()} className="shrink-0">
          Добавить
        </Button>
      </form>
    </section>
  );
}
