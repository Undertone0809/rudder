import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "@/context/I18nContext";
import type { InstanceLocale } from "@rudderhq/shared";
import { useCallback, useEffect, useMemo, useState } from "react";

type SchedulePreset = "every_minute" | "every_hour" | "every_day" | "weekdays" | "weekly" | "monthly" | "custom";

const PRESETS: { value: SchedulePreset; label: string }[] = [
  { value: "every_minute", label: "Every minute" },
  { value: "every_hour", label: "Every hour" },
  { value: "every_day", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom (cron)" },
];

const HOURS = Array.from({ length: 24 }, (_, i) => ({
  value: String(i),
  label: String(i).padStart(2, "0"),
}));

const MINUTES = Array.from({ length: 12 }, (_, i) => ({
  value: String(i * 5),
  label: String(i * 5).padStart(2, "0"),
}));

const DAYS_OF_WEEK = [
  { value: "1", label: "Mon" },
  { value: "2", label: "Tue" },
  { value: "3", label: "Wed" },
  { value: "4", label: "Thu" },
  { value: "5", label: "Fri" },
  { value: "6", label: "Sat" },
  { value: "0", label: "Sun" },
];

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => ({
  value: String(i + 1),
  label: String(i + 1),
}));

const ZH_PRESET_LABELS: Record<SchedulePreset, string> = {
  every_minute: "每分钟",
  every_hour: "每小时",
  every_day: "每天",
  weekdays: "工作日",
  weekly: "每周",
  monthly: "每月",
  custom: "自定义 cron",
};

const ZH_DAYS_OF_WEEK: Record<string, string> = {
  "1": "周一",
  "2": "周二",
  "3": "周三",
  "4": "周四",
  "5": "周五",
  "6": "周六",
  "0": "周日",
};

function schedulePresetLabel(preset: SchedulePreset, locale: InstanceLocale) {
  return locale === "zh-CN"
    ? ZH_PRESET_LABELS[preset]
    : PRESETS.find((item) => item.value === preset)?.label ?? preset;
}

function dayOfWeekLabel(day: string, locale: InstanceLocale) {
  return locale === "zh-CN"
    ? ZH_DAYS_OF_WEEK[day] ?? day
    : DAYS_OF_WEEK.find((item) => item.value === day)?.label ?? day;
}

function parseCronToPreset(cron: string): {
  preset: SchedulePreset;
  hour: string;
  minute: string;
  dayOfWeek: string;
  dayOfMonth: string;
} {
  const defaults = { hour: "10", minute: "0", dayOfWeek: "1", dayOfMonth: "1" };

  if (!cron || !cron.trim()) {
    return { preset: "every_day", ...defaults };
  }

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { preset: "custom", ...defaults };
  }

  const [min, hr, dom, , dow] = parts;

  // Every minute: "* * * * *"
  if (min === "*" && hr === "*" && dom === "*" && dow === "*") {
    return { preset: "every_minute", ...defaults };
  }

  // Every hour: "0 * * * *"
  if (hr === "*" && dom === "*" && dow === "*") {
    return { preset: "every_hour", ...defaults, minute: min === "*" ? "0" : min };
  }

  // Every day: "M H * * *"
  if (dom === "*" && dow === "*" && hr !== "*") {
    return { preset: "every_day", ...defaults, hour: hr, minute: min === "*" ? "0" : min };
  }

  // Weekdays: "M H * * 1-5"
  if (dom === "*" && dow === "1-5" && hr !== "*") {
    return { preset: "weekdays", ...defaults, hour: hr, minute: min === "*" ? "0" : min };
  }

  // Weekly: "M H * * D" (single day)
  if (dom === "*" && /^\d$/.test(dow) && hr !== "*") {
    return { preset: "weekly", ...defaults, hour: hr, minute: min === "*" ? "0" : min, dayOfWeek: dow };
  }

  // Monthly: "M H D * *"
  if (/^\d{1,2}$/.test(dom) && dow === "*" && hr !== "*") {
    return { preset: "monthly", ...defaults, hour: hr, minute: min === "*" ? "0" : min, dayOfMonth: dom };
  }

  return { preset: "custom", ...defaults };
}

function buildCron(preset: SchedulePreset, hour: string, minute: string, dayOfWeek: string, dayOfMonth: string): string {
  switch (preset) {
    case "every_minute":
      return "* * * * *";
    case "every_hour":
      return `${minute} * * * *`;
    case "every_day":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${dayOfWeek}`;
    case "monthly":
      return `${minute} ${hour} ${dayOfMonth} * *`;
    case "custom":
      return "";
  }
}

export function describeSchedule(cron: string, locale: InstanceLocale): string {
  const { preset, hour, minute, dayOfWeek, dayOfMonth } = parseCronToPreset(cron);
  const hourLabel = HOURS.find((h) => h.value === hour)?.label ?? `${hour}`;
  const timeStr = `${hourLabel.padStart(2, "0")}:${minute.padStart(2, "0")}`;

  switch (preset) {
    case "every_minute":
      return locale === "zh-CN" ? "每分钟" : "Every minute";
    case "every_hour":
      return locale === "zh-CN" ? `每小时 ${Number(minute)} 分` : `Every hour at :${minute.padStart(2, "0")}`;
    case "every_day":
      return locale === "zh-CN" ? `每天 ${timeStr}` : `Every day at ${timeStr}`;
    case "weekdays":
      return locale === "zh-CN" ? `工作日 ${timeStr}` : `Weekdays at ${timeStr}`;
    case "weekly": {
      const zhDays: Record<string, string> = {
        "1": "一",
        "2": "二",
        "3": "三",
        "4": "四",
        "5": "五",
        "6": "六",
        "0": "日",
      };
      const day = locale === "zh-CN" ? zhDays[dayOfWeek] ?? dayOfWeek : DAYS_OF_WEEK.find((d) => d.value === dayOfWeek)?.label ?? dayOfWeek;
      return locale === "zh-CN" ? `每周${day} ${timeStr}` : `Every ${day} at ${timeStr}`;
    }
    case "monthly":
      return locale === "zh-CN" ? `每月 ${dayOfMonth} 日 ${timeStr}` : `Monthly on the ${dayOfMonth}${ordinalSuffix(Number(dayOfMonth))} at ${timeStr}`;
    case "custom":
      return cron || (locale === "zh-CN" ? "未设置日程" : "No schedule set");
  }
}

function ordinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

export function ScheduleEditor({
  value,
  onChange,
  variant = "default",
}: {
  value: string;
  onChange: (cron: string) => void;
  variant?: "default" | "compact";
}) {
  const parsed = useMemo(() => parseCronToPreset(value), [value]);
  const [preset, setPreset] = useState<SchedulePreset>(parsed.preset);
  const [hour, setHour] = useState(parsed.hour);
  const [minute, setMinute] = useState(parsed.minute);
  const [dayOfWeek, setDayOfWeek] = useState(parsed.dayOfWeek);
  const [dayOfMonth, setDayOfMonth] = useState(parsed.dayOfMonth);
  const [customCron, setCustomCron] = useState(preset === "custom" ? value : "");
  const { locale } = useI18n();

  // Sync from external value changes
  useEffect(() => {
    const p = parseCronToPreset(value);
    setPreset(p.preset);
    setHour(p.hour);
    setMinute(p.minute);
    setDayOfWeek(p.dayOfWeek);
    setDayOfMonth(p.dayOfMonth);
    if (p.preset === "custom") setCustomCron(value);
  }, [value]);

  const emitChange = useCallback(
    (p: SchedulePreset, h: string, m: string, dow: string, dom: string, custom: string) => {
      if (p === "custom") {
        onChange(custom);
      } else {
        onChange(buildCron(p, h, m, dow, dom));
      }
    },
    [onChange],
  );

  const handlePresetChange = (newPreset: SchedulePreset) => {
    setPreset(newPreset);
    if (newPreset === "custom") {
      setCustomCron(value);
    } else {
      emitChange(newPreset, hour, minute, dayOfWeek, dayOfMonth, customCron);
    }
  };

  const handleTimeChange = (timeValue: string) => {
    const [rawHour, rawMinute] = timeValue.split(":");
    if (rawHour === undefined || rawMinute === undefined) return;
    const nextHour = String(Number(rawHour));
    const nextMinute = String(Number(rawMinute));
    setHour(nextHour);
    setMinute(nextMinute);
    emitChange(preset, nextHour, nextMinute, dayOfWeek, dayOfMonth, customCron);
  };

  if (variant === "compact") {
    const showTime = preset !== "every_minute" && preset !== "every_hour" && preset !== "custom";

    return (
      <div className="space-y-2">
        <Select value={preset} onValueChange={(v) => handlePresetChange(v as SchedulePreset)}>
          <SelectTrigger className="h-12 w-full rounded-md border-border/75 bg-background/60 px-3 text-base shadow-none md:text-sm">
            <SelectValue placeholder={locale === "zh-CN" ? "选择频率..." : "Choose frequency..."} />
          </SelectTrigger>
          <SelectContent>
            {PRESETS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {schedulePresetLabel(p.value, locale)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {showTime ? (
          <Input
            type="time"
            step={300}
            value={`${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`}
            onChange={(event) => handleTimeChange(event.target.value)}
            className="h-12 rounded-md border-border/75 bg-background/60 text-base shadow-none md:text-sm"
          />
        ) : null}

        {preset === "every_hour" ? (
          <Select
            value={minute}
            onValueChange={(m) => {
              setMinute(m);
              emitChange(preset, hour, m, dayOfWeek, dayOfMonth, customCron);
            }}
          >
            <SelectTrigger className="h-12 w-full rounded-md border-border/75 bg-background/60 px-3 text-base shadow-none md:text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MINUTES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  :{m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {preset === "weekly" ? (
          <Select
            value={dayOfWeek}
            onValueChange={(dow) => {
              setDayOfWeek(dow);
              emitChange(preset, hour, minute, dow, dayOfMonth, customCron);
            }}
          >
            <SelectTrigger className="h-12 w-full rounded-md border-border/75 bg-background/60 px-3 text-base shadow-none md:text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DAYS_OF_WEEK.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {dayOfWeekLabel(d.value, locale)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {preset === "monthly" ? (
          <Select
            value={dayOfMonth}
            onValueChange={(dom) => {
              setDayOfMonth(dom);
              emitChange(preset, hour, minute, dayOfWeek, dom, customCron);
            }}
          >
            <SelectTrigger className="h-12 w-full rounded-md border-border/75 bg-background/60 px-3 text-base shadow-none md:text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DAYS_OF_MONTH.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {preset === "custom" ? (
          <Input
            value={customCron}
            onChange={(e) => {
              setCustomCron(e.target.value);
              emitChange("custom", hour, minute, dayOfWeek, dayOfMonth, e.target.value);
            }}
            placeholder="0 10 * * *"
            className="h-12 rounded-md border-border/75 bg-background/60 font-mono text-sm shadow-none"
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Select value={preset} onValueChange={(v) => handlePresetChange(v as SchedulePreset)}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={locale === "zh-CN" ? "选择频率..." : "Choose frequency..."} />
        </SelectTrigger>
        <SelectContent>
          {PRESETS.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {schedulePresetLabel(p.value, locale)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {preset === "custom" ? (
        <div className="space-y-1.5">
          <Input
            value={customCron}
            onChange={(e) => {
              setCustomCron(e.target.value);
              emitChange("custom", hour, minute, dayOfWeek, dayOfMonth, e.target.value);
            }}
            placeholder="0 10 * * *"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {locale === "zh-CN" ? "五个字段：分钟 小时 日期 月份 星期" : "Five fields: minute hour day-of-month month day-of-week"}
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {preset !== "every_minute" && preset !== "every_hour" && (
            <>
              <span className="text-sm text-muted-foreground">{locale === "zh-CN" ? "时间" : "at"}</span>
              <Select
                value={hour}
                onValueChange={(h) => {
                  setHour(h);
                  emitChange(preset, h, minute, dayOfWeek, dayOfMonth, customCron);
                }}
              >
                <SelectTrigger className="w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOURS.map((h) => (
                    <SelectItem key={h.value} value={h.value}>
                      {h.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-sm text-muted-foreground">:</span>
              <Select
                value={minute}
                onValueChange={(m) => {
                  setMinute(m);
                  emitChange(preset, hour, m, dayOfWeek, dayOfMonth, customCron);
                }}
              >
                <SelectTrigger className="w-[80px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MINUTES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}

          {preset === "every_hour" && (
            <>
              <span className="text-sm text-muted-foreground">{locale === "zh-CN" ? "第几分钟" : "at minute"}</span>
              <Select
                value={minute}
                onValueChange={(m) => {
                  setMinute(m);
                  emitChange(preset, hour, m, dayOfWeek, dayOfMonth, customCron);
                }}
              >
                <SelectTrigger className="w-[80px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MINUTES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      :{m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}

          {preset === "weekly" && (
            <>
              <span className="text-sm text-muted-foreground">{locale === "zh-CN" ? "在" : "on"}</span>
              <div className="flex gap-1">
                {DAYS_OF_WEEK.map((d) => (
                  <Button
                    key={d.value}
                    type="button"
                    variant={dayOfWeek === d.value ? "default" : "outline"}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      setDayOfWeek(d.value);
                      emitChange(preset, hour, minute, d.value, dayOfMonth, customCron);
                    }}
                  >
                    {dayOfWeekLabel(d.value, locale)}
                  </Button>
                ))}
              </div>
            </>
          )}

          {preset === "monthly" && (
            <>
              <span className="text-sm text-muted-foreground">{locale === "zh-CN" ? "日期" : "on day"}</span>
              <Select
                value={dayOfMonth}
                onValueChange={(dom) => {
                  setDayOfMonth(dom);
                  emitChange(preset, hour, minute, dayOfWeek, dom, customCron);
                }}
              >
                <SelectTrigger className="w-[80px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAYS_OF_MONTH.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
        </div>
      )}
    </div>
  );
}
