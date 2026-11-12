begin;

-- Accept older deployed clients and persist the new label.
create or replace function public.normalize_message_daily_zone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.zone = '校园生活' then
    new.zone := '日常分享';
  end if;
  return new;
end;
$$;

drop trigger if exists normalize_message_daily_zone on public.messages;
create trigger normalize_message_daily_zone
before insert or update of zone on public.messages
for each row execute function public.normalize_message_daily_zone();

alter table public.messages
  drop constraint if exists messages_zone_check,
  alter column zone set default '日常分享';

update public.messages set zone = '日常分享' where zone = '校园生活';

alter table public.messages
  add constraint messages_zone_check
  check (zone in ('日常分享', '学习互助', '活动社团', '失物招领'));

commit;
