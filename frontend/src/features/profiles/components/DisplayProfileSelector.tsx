import type { DisplayProfileT } from 'shared';
import { Select, SelectItem } from '@/components/ui/Select';
import { selectableDisplayProfiles } from '@/features/profiles/profile-environment';

interface DisplayProfileSelectorProps {
  value: string;
  onChange: (profileId: string) => void;
  profiles?: ReadonlyArray<DisplayProfileT>;
  label?: string;
  compact?: boolean;
}

export function DisplayProfileSelector({
  value,
  onChange,
  profiles = selectableDisplayProfiles(),
  label = 'Display Profile',
  compact,
}: DisplayProfileSelectorProps) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-stone">
        {label}
      </span>
      <Select
        value={value}
        onValueChange={onChange}
        aria-label={label}
        className={compact ? 'py-2 font-mono text-[12px]' : undefined}
      >
        {profiles.map((profile) => (
          <SelectItem
            key={profile.id}
            value={profile.id}
            hint={`${profile.width}x${profile.height}`}
          >
            {profile.id}
          </SelectItem>
        ))}
      </Select>
    </label>
  );
}
