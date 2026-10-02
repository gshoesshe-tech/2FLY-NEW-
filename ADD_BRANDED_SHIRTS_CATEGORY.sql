-- ============================================================================
-- 2FLY — ADD BRANDED SHIRTS CATEGORY
--
-- Category:
--   Code: BRANDED_SHIRTS
--   Name: Branded Shirts
--
-- Inventory:
--   Starts at 0 on-hand and 0 reserved.
--   Enter your real stock manually from Inventory if/when you use inventory again.
--
-- Parser labels recognized:
--   BRANDED SHIRT
--   BRANDED SHIRTS
--   BRANDED TSHIRT
--   BRANDED TSHIRTS
--
-- Representative product:
--   BRANDED-SHIRT-GENERAL
--   Default sell price: 199
--
-- Safe to rerun. Existing orders are not changed.
-- ============================================================================

begin;

do $$
declare
  v_category_id uuid;
  v_candidate_count integer;
  v_conflicting_alias text;
begin
  if to_regclass('public.inventory_categories') is null
     or to_regclass('public.inventory_category_balances') is null
     or to_regclass('public.category_aliases') is null
     or to_regclass('public.products') is null then
    raise exception 'STOP: Required Daily Operations tables are missing.';
  end if;

  select count(*)
  into v_candidate_count
  from public.inventory_categories
  where code = 'BRANDED_SHIRTS'
     or upper(trim(name)) in ('BRANDED SHIRT', 'BRANDED SHIRTS');

  select id
  into v_category_id
  from public.inventory_categories
  where code = 'BRANDED_SHIRTS'
     or upper(trim(name)) in ('BRANDED SHIRT', 'BRANDED SHIRTS')
  order by id::text
  limit 1;

  if v_candidate_count > 1 then
    raise exception 'STOP: More than one Branded Shirts category candidate exists. No changes were saved.';
  end if;

  if v_category_id is null then
    insert into public.inventory_categories (
      id, code, name, active, low_stock_level
    )
    values (
      gen_random_uuid(), 'BRANDED_SHIRTS', 'Branded Shirts', true, 0
    )
    returning id into v_category_id;
  else
    update public.inventory_categories
    set code = 'BRANDED_SHIRTS',
        name = 'Branded Shirts',
        active = true,
        updated_at = now()
    where id = v_category_id;
  end if;

  select ca.alias
  into v_conflicting_alias
  from public.category_aliases ca
  where ca.alias in ('BRANDED SHIRT', 'BRANDED SHIRTS', 'BRANDED TSHIRT', 'BRANDED TSHIRTS')
    and ca.category_id <> v_category_id
  limit 1;

  if v_conflicting_alias is not null then
    raise exception 'STOP: Alias % is already connected to another category. No changes were saved.', v_conflicting_alias;
  end if;

  insert into public.inventory_category_balances (
    category_id, on_hand, reserved, updated_at
  )
  values (
    v_category_id, 0, 0, now()
  )
  on conflict (category_id) do nothing;

  insert into public.category_aliases (alias, category_id)
  values
    ('BRANDED SHIRT', v_category_id),
    ('BRANDED SHIRTS', v_category_id),
    ('BRANDED TSHIRT', v_category_id),
    ('BRANDED TSHIRTS', v_category_id)
  on conflict (alias) do update
    set category_id = excluded.category_id;

  insert into public.products (
    id,
    category_id,
    code,
    name,
    default_sell_price,
    requires_size,
    allowed_sizes,
    active
  )
  values (
    gen_random_uuid(),
    v_category_id,
    'BRANDED-SHIRT-GENERAL',
    'Branded Shirts',
    199,
    false,
    array[]::text[],
    true
  )
  on conflict (code) do update
    set category_id = excluded.category_id,
        name = excluded.name,
        default_sell_price = 199,
        requires_size = false,
        allowed_sizes = array[]::text[],
        active = true,
        updated_at = now();
end
$$;

commit;

select
  'BRANDED SHIRTS CATEGORY COMPLETE' as result,
  c.id as category_id,
  c.code,
  c.name,
  c.active,
  b.on_hand,
  b.reserved,
  b.on_hand - b.reserved as available,
  p.code as representative_product_code,
  p.default_sell_price,
  array_agg(a.alias order by a.alias) as recognized_labels
from public.inventory_categories c
join public.inventory_category_balances b on b.category_id = c.id
join public.products p on p.category_id = c.id and p.code = 'BRANDED-SHIRT-GENERAL'
left join public.category_aliases a on a.category_id = c.id
where c.code = 'BRANDED_SHIRTS'
group by c.id, c.code, c.name, c.active, b.on_hand, b.reserved, p.code, p.default_sell_price;
