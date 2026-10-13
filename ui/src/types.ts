import { z } from "zod";

export const RoomIdSchema = z.string().brand<"RoomId">();
export const RevisionSchema = z.string().brand<"Revision">();
export const FixtureTagSchema = z.string().min(1).brand<"FixtureTag">();

export type RoomId = z.infer<typeof RoomIdSchema>;
export type Revision = z.infer<typeof RevisionSchema>;
export type FixtureTag = z.infer<typeof FixtureTagSchema>;

export const PointSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });
export type Point = z.infer<typeof PointSchema>;

export const VectorSchema = PointSchema;

export const BoundsSchema = z.object({ minimum: PointSchema, maximum: PointSchema });

export const PolygonSchema = z.object({
  outer: z.array(z.object({ x: z.number(), y: z.number() })).min(3),
  holes: z.array(z.array(z.object({ x: z.number(), y: z.number() }))),
});

export const SpotlightSpecSchema = z.object({
  model: z.string().nullable(),
  lumens: z.number().positive().nullable(),
  beam_angle_deg: z.number().positive(),
  cct_kelvin: z.number().int().positive().nullable(),
  cri: z.number().min(0).max(100).nullable(),
  dimmable: z.boolean(),
  diameter_mm: z.number().positive(),
  cutout_diameter_mm: z.number().positive(),
  mounting_depth_mm: z.number().positive(),
  ies_path: z.string().nullable(),
  peak_candela: z.number().positive().nullable(),
  ip_rating: z.string().nullish(),
});
export type SpotlightSpec = z.infer<typeof SpotlightSpecSchema>;

export const RecessedSpotlightSchema = z.object({
  id: z.string().optional(),
  kind: z.literal("recessed_spotlight"),
  tag: FixtureTagSchema,
  room_id: RoomIdSchema,
  point: PointSchema,
  spec: SpotlightSpecSchema,
  switching_group: z.string().min(1),
  direction: VectorSchema,
  notes: z.array(z.string()),
});

export const PendantSpecSchema = z.object({
  model: z.string().nullable(),
  lumens: z.number().positive().nullable(),
  cct_kelvin: z.number().int().positive().nullable(),
  cri: z.number().min(0).max(100).nullable(),
  dimmable: z.boolean(),
  drop_mm: z.number().positive(),
  canopy_diameter_mm: z.number().positive(),
  canopy_depth_mm: z.number().positive(),
  bulb_diameter_mm: z.number().positive(),
  ies_path: z.string().nullable(),
});

const PendantFixtureSchema = z.object({
  id: z.string().optional(),
  kind: z.literal("pendant_bulb"),
  tag: FixtureTagSchema,
  room_id: RoomIdSchema,
  point: PointSchema,
  spec: PendantSpecSchema,
  switching_group: z.string().min(1),
  notes: z.array(z.string()),
});

export const RopeLightSpecSchema = z.object({
  model: z.string().nullable(),
  lumens_per_m: z.number().positive().nullable(),
  cct_kelvin: z.number().int().positive().nullable(),
  cri: z.number().min(0).max(100).nullable(),
  dimmable: z.boolean(),
  diameter_mm: z.number().positive(),
  minimum_bend_radius_mm: z.number().positive(),
  mounting: z.enum(["ceiling", "wall", "concealed", "joinery"]),
  ip_rating: z.string().nullish(),
});

const RopeLightFixtureSchema = z.object({
  id: z.string().optional(),
  kind: z.literal("rope_light"),
  tag: FixtureTagSchema,
  room_id: RoomIdSchema,
  path: z.array(PointSchema).min(2),
  spec: RopeLightSpecSchema,
  switching_group: z.string().min(1),
  notes: z.array(z.string()),
});

const TypedFixtureSchema = z.discriminatedUnion("kind", [
  RecessedSpotlightSchema,
  PendantFixtureSchema,
  RopeLightFixtureSchema,
]);

export const FixtureSchema = z.preprocess((value) => {
  if (typeof value !== "object" || value === null || "kind" in value) return value;
  return { ...value, kind: "recessed_spotlight" };
}, TypedFixtureSchema);
export type Fixture = z.infer<typeof FixtureSchema>;

export type PointFixture = Extract<Fixture, { kind: "recessed_spotlight" | "pendant_bulb" }>;
export type RecessedSpotlight = Extract<Fixture, { kind: "recessed_spotlight" }>;

export const WallSwitchSchema = z.object({
  id: z.string().optional(),
  tag: z.string().min(1),
  room_id: RoomIdSchema,
  host_wall_id: z.string().min(1),
  offset_mm: z.number().min(0),
  mounting_height_mm: z.number().positive(),
  switching_group: z.string().min(1),
  mounting_face: z.enum(["room", "opposite"]).default("room"),
  point: PointSchema.optional(),
  spec: z.object({
    kind: z.enum(["toggle", "dimmer", "momentary"]),
    width_mm: z.number().positive(),
    height_mm: z.number().positive(),
    depth_mm: z.number().positive(),
  }),
  notes: z.array(z.string()),
});
export type WallSwitch = z.infer<typeof WallSwitchSchema>;

export const ControlGroupSchema = z.object({
  id: z.string(),
  label: z.string().min(1),
  switch_ids: z.array(z.string()),
  luminaire_ids: z.array(z.string()),
  sensor_ids: z.array(z.string()).default([]),
});
export type ControlGroup = z.infer<typeof ControlGroupSchema>;

export const FindingSchema = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  fixture_tags: z.array(z.string()),
  measured_mm: z.number().nullable(),
  required_mm: z.number().nullable(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ValidationSchema = z.object({ findings: z.array(FindingSchema) });
export type Validation = z.infer<typeof ValidationSchema>;

const RoomSchema = z.object({
  id: RoomIdSchema,
  name: z.string(),
  storey_id: z.string(),
  elevation_mm: z.number(),
  bounds: BoundsSchema,
  is_external: z.boolean().default(false),
  part_of: z.string().nullish(),
  floor_finish: z.string().nullish(),
  wall_finish: z.string().nullish(),
  feature_wall_id: z.string().nullish(),
  feature_wall: z.string().nullish(),
  feature_wall_colour: z.string().nullish(),
  skirting: z.string().nullish(),
  skirting_height_mm: z.number().nullish(),
  skirting_thickness_mm: z.number().nullish(),
  clad_wall_ids: z.array(z.string()).nullish(),
  clad_wall: z.string().nullish(),
});
export type Room = z.infer<typeof RoomSchema>;

const BuildingSchema = z.object({
  id: z.string(),
  name: z.string(),
  schema: z.string(),
  units: z.string(),
  origin: PointSchema,
  axes: z.string(),
  revision: RevisionSchema,
});

const StoreySchema = z.object({ id: z.string(), name: z.string(), elevation_mm: z.number() });

export const ProjectSchema = z.object({
  building: BuildingSchema,
  storeys: z.array(StoreySchema),
  rooms: z.array(RoomSchema),
  model_path: z.string(),
  server_stale: z.boolean().default(false),
});
export type Project = z.infer<typeof ProjectSchema>;

const BuildingObjectSchema = z.object({
  id: z.string(),
  ifc_class: z.string(),
  kind: z.string(),
  name: z.string(),
  room_ids: z.array(z.string()),
  bounds: BoundsSchema,
  properties: z.record(z.string(), z.unknown()),
  plan_footprint: PolygonSchema.nullish(),
});
export type BuildingObject = z.infer<typeof BuildingObjectSchema>;

const WallSchema = z.object({
  wall_id: z.string(),
  start: z.object({ x: z.number(), y: z.number() }),
  end: z.object({ x: z.number(), y: z.number() }),
  inward_normal: VectorSchema,
  thickness_mm: z.number().positive(),
  base_elevation_mm: z.number().nullish(),
  top_elevation_mm: z.number().nullish(),
});
export type Wall = z.infer<typeof WallSchema>;

const SoffitSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  room_id: RoomIdSchema,
  footprint: PolygonSchema,
  elevation_mm: z.number(),
  height_above_floor_mm: z.number(),
  evidence: z.string(),
});
export type Soffit = z.infer<typeof SoffitSchema>;

const OpeningSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["window", "door", "sliding_door", "unfilled"]),
  room_ids: z.array(z.string()),
  host_wall_id: z.string(),
  start: z.object({ x: z.number(), y: z.number() }),
  end: z.object({ x: z.number(), y: z.number() }),
  sill_height_mm: z.number(),
  head_height_mm: z.number(),
  exposure: z.string(),
  evidence: z.string(),
  swing: z.enum(["inward", "outward"]).nullish(),
  /** How much of the opening is glass. A solid leaf stops light; glass does not. */
  glazing_fraction: z.number().min(0).max(1).optional(),
});
export type Opening = z.infer<typeof OpeningSchema>;

const DaylightSourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  footprint: PolygonSchema,
  bounds: BoundsSchema,
  daylight_role: z.string(),
  evidence: z.string(),
});
export type DaylightSource = z.infer<typeof DaylightSourceSchema>;

export const StairSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  footprint: PolygonSchema,
  bounds: BoundsSchema,
  base_elevation_mm: z.number(),
  rise_mm: z.number(),
  tread_depth_mm: z.number(),
  riser_height_mm: z.number(),
  tread_count: z.number().int().positive(),
  riser_count: z.number().int().positive(),
  up_bearing_deg: z.number(),
  room_ids: z.array(z.string()),
  evidence: z.string(),
  finish: z.string().nullish(),
  skirting: z.string().nullish(),
  skirting_height_mm: z.number().nullish(),
  skirting_thickness_mm: z.number().nullish(),
});
export type Stair = z.infer<typeof StairSchema>;

export const TaskAreaSchema = z.object({
  border_mm: z.number(),
  sample_count: z.number().int(),
  mean_lux: z.number(),
  minimum_lux: z.number(),
  maximum_lux: z.number(),
  uniformity: z.number(),
  covered_fraction: z.number(),
});
export type TaskArea = z.infer<typeof TaskAreaSchema>;

export const BakedSampleSchema = z.object({
  point: PointSchema,
  lux: z.number(),
  lit_by: z.number().int(),
  shadowed_by: z.number().int(),
});
export type BakedSample = z.infer<typeof BakedSampleSchema>;

export const BakedLightingSchema = z.object({
  room_id: z.string(),
  samples: z.array(BakedSampleSchema),
  plane_elevation_mm: z.number(),
  step_mm: z.number().positive(),
  threshold_lux: z.number(),
  maximum_lux: z.number(),
  mean_lux: z.number(),
  covered_fraction: z.number(),
  shadowed_fraction: z.number(),
  occluders: z.array(z.string()),
  fixture_count: z.number().int(),
  dark_regions: z
    .array(
      z.object({
        area_m2: z.number(),
        minimum_lux: z.number(),
        mean_lux: z.number(),
        centre: PointSchema,
        sample_count: z.number().int(),
      }),
    )
    .default([]),
  interreflection: z
    .object({
      lux: z.number(),
      average_reflectance: z.number(),
      surface_area_m2: z.number(),
      luminous_flux_lm: z.number(),
      reflectances: z.array(z.tuple([z.string(), z.number()])).default([]),
      maintenance_factor: z.number().default(1),
      method: z.string(),
      exclusions: z.array(z.string()),
    })
    .nullish(),
  maintenance_factor: z.number().default(1),
  task_area: TaskAreaSchema.nullish(),
  method: z.enum([
    "direct_occluded_v1",
    "direct_occluded_plus_room_interreflection_v1",
    "ies_lm63_occluded_v1",
    "ies_lm63_occluded_plus_room_interreflection_v1",
  ]),
  exclusions: z.array(z.string()),
});
export type BakedLighting = z.infer<typeof BakedLightingSchema>;

export const BakeResponseSchema = z.object({ baked: BakedLightingSchema });

export const DarkZoneSchema = z.object({
  point: PointSchema,
  estimated_lux: z.number(),
  threshold_lux: z.number(),
  method: z.string(),
  disclaimer: z.string(),
});
export type DarkZone = z.infer<typeof DarkZoneSchema>;

export const LuxSampleSchema = z.object({
  point: PointSchema,
  lux: z.number(),
  method: z.string(),
});
export type LuxSample = z.infer<typeof LuxSampleSchema>;

export const IlluminanceGridSchema = z.object({
  samples: z.array(LuxSampleSchema),
  plane_elevation_mm: z.number(),
  step_mm: z.number().positive(),
  threshold_lux: z.number(),
  maximum_lux: z.number(),
  mean_lux: z.number(),
  covered_fraction: z.number(),
  maintenance_factor: z.number().default(1),
  task_area: TaskAreaSchema.nullish(),
  method: z.string(),
});
export type IlluminanceGrid = z.infer<typeof IlluminanceGridSchema>;

export const ElectricLightingAnalysisSchema = z.object({
  validation: ValidationSchema,
  dark_zones: z.array(DarkZoneSchema),
  illuminance: IlluminanceGridSchema.nullable().default(null),
  // Weakest tier first, matching the label Python chooses in `_layout_method`.
  method: z.enum([
    "lumen_beam_cone_with_uniform_diffuser_v1",
    "lumen_beam_cone_v1",
    "peak_candela_beam_falloff_v1",
    "mixed_ies_and_lumen_beam_cone_v1",
    "ies_lm63_point_v1",
  ]),
  exclusions: z.array(z.string()),
});
export type ElectricLightingAnalysis = z.infer<typeof ElectricLightingAnalysisSchema>;

export const SiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  latitude_deg: z.number().nullable(),
  longitude_deg: z.number().nullable(),
  elevation_mm: z.number(),
  true_north_deg: z.number(),
  timezone: z.string().nullable(),
  evidence: z.string(),
});
export type Site = z.infer<typeof SiteSchema>;

export const SolarPositionSchema = z.object({
  when: z.string(),
  altitude_deg: z.number(),
  azimuth_deg: z.number(),
  declination_deg: z.number(),
  hour_angle_deg: z.number(),
  equation_of_time_min: z.number(),
  above_horizon: z.boolean(),
  method: z.string(),
});
export type SolarPosition = z.infer<typeof SolarPositionSchema>;

export const SunPatchSchema = z.object({
  opening_id: z.string(),
  opening_name: z.string(),
  opening_kind: z.string(),
  pieces: z.array(PolygonSchema),
  projected: PolygonSchema,
  plane_elevation_mm: z.number(),
  area_m2: z.number(),
  projected_area_m2: z.number(),
  incidence_deg: z.number(),
  method: z.string(),
  clip_method: z.string(),
});
export type SunPatch = z.infer<typeof SunPatchSchema>;

export const RoomDaylightSchema = z.object({
  room_id: z.string(),
  site: SiteSchema,
  when: z.string(),
  plane_elevation_mm: z.number(),
  position: SolarPositionSchema.nullable(),
  sun_direction: VectorSchema.nullable(),
  patches: z.array(SunPatchSchema),
  notes: z.array(z.string()),
  method: z.string(),
  exclusions: z.array(z.string()),
});
export type RoomDaylight = z.infer<typeof RoomDaylightSchema>;

export const SunPathSchema = z.object({
  date: z.string(),
  step_minutes: z.number(),
  samples: z.array(z.object({ when: z.string(), altitude_deg: z.number(), azimuth_deg: z.number() })),
  sunrise: z.string().nullable(),
  sunset: z.string().nullable(),
  solar_noon: z.string().nullable(),
  max_altitude_deg: z.number(),
  method: z.string(),
});
export type SunPath = z.infer<typeof SunPathSchema>;

export const DaylightResponseSchema = z.object({
  daylight: RoomDaylightSchema,
  sun_path: SunPathSchema.nullable(),
  resolved_at: z.string(),
  plane: z.enum(["floor", "task"]),
});
export type DaylightResponse = z.infer<typeof DaylightResponseSchema>;

export const SensorSpecSchema = z.object({
  kind: z.literal("movement").default("movement"),
  diameter_mm: z.number(),
  cutout_diameter_mm: z.number(),
  mounting_depth_mm: z.number(),
  detection_diameter_mm: z.number().nullish(),
});
export type SensorSpec = z.infer<typeof SensorSpecSchema>;

export const SensorSchema = z.object({
  id: z.string().optional(),
  tag: z.string(),
  room_id: RoomIdSchema,
  point: PointSchema,
  run_on_minutes: z.number(),
  switching_group: z.string().nullish(),
  controls_tag: z.string().nullish(),
  spec: SensorSpecSchema,
  notes: z.array(z.string()).default([]),
  kind: z.literal("movement_sensor").default("movement_sensor"),
});
export type Sensor = z.infer<typeof SensorSchema>;

export const DesignSchema = z.object({
  revision: RevisionSchema,
  room: RoomSchema,
  ceiling: z.object({
    room_id: RoomIdSchema,
    polygon: PolygonSchema,
    elevation_mm: z.number(),
    source: z.string(),
    structural_elevation_mm: z.number().nullish(),
  }),
  walls: z.array(WallSchema),
  openings: z.array(OpeningSchema),
  daylight_sources: z.array(DaylightSourceSchema),
  stairs: z.array(StairSchema).default([]),
  soffits: z.array(SoffitSchema).default([]),
  furniture: z.array(BuildingObjectSchema),
  obstructions: z.array(BuildingObjectSchema),
  fixtures: z.array(FixtureSchema),
  switches: z.array(WallSwitchSchema).default([]),
  sensors: z.array(SensorSchema).default([]),
  control_groups: z.array(ControlGroupSchema).default([]),
  analysis: ElectricLightingAnalysisSchema,
  constraints: z.object({
    wall_clearance_mm: z.number(),
    minimum_spacing_mm: z.number(),
    obstruction_clearance_mm: z.number(),
    shadow_gap_clearance_mm: z.number(),
    alignment_tolerance_mm: z.number(),
    collision_tolerance_mm: z.number(),
    target_lux: z.number(),
    task_plane_height_mm: z.number(),
    utilization_factor: z.number(),
    grid_step_mm: z.number(),
    avoid_object_kinds: z.array(z.string()),
  }),
});
export type Design = z.infer<typeof DesignSchema>;

const PlanRoomGeometrySchema = z.object({
  room: RoomSchema,
  ceiling: z.object({
    room_id: RoomIdSchema,
    polygon: PolygonSchema,
    elevation_mm: z.number(),
    source: z.string(),
    structural_elevation_mm: z.number().nullish(),
  }),
  walls: z.array(WallSchema),
  openings: z.array(OpeningSchema),
  daylight_sources: z.array(DaylightSourceSchema),
  stairs: z.array(StairSchema).default([]),
  soffits: z.array(SoffitSchema).default([]),
  furniture: z.array(BuildingObjectSchema),
  obstructions: z.array(BuildingObjectSchema),
  fixtures: z.array(FixtureSchema),
  switches: z.array(WallSwitchSchema).default([]),
  sensors: z.array(SensorSchema).default([]),
});
export type PlanRoomGeometry = z.infer<typeof PlanRoomGeometrySchema>;

export const WholePlanSchema = z.object({
  revision: RevisionSchema,
  site: SiteSchema,
  constraints: DesignSchema.shape.constraints,
  control_groups: z.array(ControlGroupSchema).default([]),
  rooms: z.array(PlanRoomGeometrySchema),
});
export type WholePlan = z.infer<typeof WholePlanSchema>;

export const LayoutProposalSchema = z.object({
  layout: z.object({ room_id: RoomIdSchema, fixtures: z.array(FixtureSchema) }),
  validation: ValidationSchema,
  model_revision: RevisionSchema,
  score: z.array(z.unknown()),
  method: z.string(),
  assumptions: z.array(z.string()),
});

export const ValidateResponseSchema = z.object({ report: ValidationSchema });

export const AlignResponseSchema = z.object({
  fixtures: z.array(FixtureSchema),
  report: ValidationSchema,
});

export const AnalysisResponseSchema = z.object({ analysis: ElectricLightingAnalysisSchema });

export const CommitResponseSchema = z.object({
  result: z.object({ revision: RevisionSchema, changed_ids: z.array(z.string()) }),
  design: DesignSchema,
});

export const ImportSummarySchema = z.object({
  import_id: z.string(),
  file_name: z.string(),
  size_bytes: z.number(),
  building: BuildingSchema,
  room_count: z.number(),
  ready_room_count: z.number(),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  can_adopt: z.boolean(),
});
export type ImportSummary = z.infer<typeof ImportSummarySchema>;

export const AdoptResponseSchema = z.object({
  revision: RevisionSchema,
  backup_path: z.string(),
  building: BuildingSchema,
  rooms: z.array(RoomSchema),
});

export const ExportResponseSchema = z.object({
  revision: RevisionSchema,
  files: z.array(z.object({ name: z.string(), url: z.string() })),
});
export type ExportResponse = z.infer<typeof ExportResponseSchema>;

export type LoadState<T> =
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "error"; message: string };

export type DraftState =
  | { kind: "clean"; report: Validation }
  | { kind: "dirty" }
  | { kind: "validating" }
  | { kind: "validated"; report: Validation }
  | { kind: "saving" };

const EvidenceStatusSchema = z.enum([
  "confirmed",
  "site_measured",
  "owner_reported",
  "traced",
  "assumed",
  "unresolved",
]);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

export const PlanEvidenceSchema = z.looseObject({
  source: z.string().min(1),
  status: EvidenceStatusSchema,
  uncertainty_mm: z.number().min(0),
  note: z.string().nullish(),
});
export type PlanEvidence = z.infer<typeof PlanEvidenceSchema>;

export const PlanPointSchema = z.looseObject({
  x_mm: z.number(),
  y_mm: z.number(),
  evidence: z.string().min(1),
});
export type PlanPoint = z.infer<typeof PlanPointSchema>;

export const PlanControlSchema = z.looseObject({
  id: z.string().min(1),
  from_point: z.string().min(1),
  to_point: z.string().min(1),
  expected_mm: z.number().positive(),
  tolerance_mm: z.number().min(0),
  // Which evidence class the expected value came from. A drawing dimension and
  // a site measurement are different claims and the plan has to tell them apart.
  evidence: z.string().min(1).nullish(),
});
export type PlanControl = z.infer<typeof PlanControlSchema>;

export const PlanRoomSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  point_ids: z.array(z.string()).min(3),
  floor_elevation_mm: z.number().default(0),
  ceiling_height_mm: z.number().positive(),
  ceiling_evidence: z.string().min(1),
  geometry_evidence: z.string().min(1),
  exposure: z.string().optional(),
});
export type PlanRoom = z.infer<typeof PlanRoomSchema>;

export const PlanApertureSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["window", "door", "sliding_door", "unfilled"]),
  host_edge: z.tuple([z.string(), z.string()]),
  width_mm: z.number().positive(),
  sill_height_mm: z.number().min(0),
  height_mm: z.number().positive(),
  room_ids: z.array(z.string()).min(1),
  exposure: z.string().min(1),
  geometry_evidence: z.string().min(1),
  height_evidence: z.string().min(1),
  glazing_fraction: z.number().min(0).max(1).default(0),
  /** A horizontal projection above this opening, and its underside. A balcony
   * floor over a slider shades it whether anyone designed it as one. */
  overhang_depth_mm: z.number().positive().nullish(),
  overhang_soffit_mm: z.number().min(0).nullish(),
  /** Distance from the first host point; null centres the opening. */
  offset_mm: z.number().min(0).nullish(),
});
export type PlanAperture = z.infer<typeof PlanApertureSchema>;

export const PlanDaylightSourceSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  point_ids: z.array(z.string()).min(3),
  daylight_role: z.string().min(1),
  geometry_evidence: z.string().min(1),
});

export type PlanDaylightSource = z.infer<typeof PlanDaylightSourceSchema>;

export const PlanSoffitSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  room_id: z.string().min(1),
  kind: z.string().min(1),
  point_ids: z.array(z.string()).min(3),
  height_mm: z.number().positive(),
  geometry_evidence: z.string().min(1),
});
export type PlanSoffit = z.infer<typeof PlanSoffitSchema>;

export const PlanStairSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  point_ids: z.array(z.string()).min(3),
  kind: z.string().min(1).default("straight_run"),
  up_bearing_deg: z.number().min(-360).max(360),
  tread_depth_mm: z.number().positive(),
  riser_height_mm: z.number().positive(),
  rise_role: z.string().min(1).default("storey"),
  room_ids: z.array(z.string()).default([]),
  geometry_evidence: z.string().min(1),
  riser_evidence: z.string().min(1),
});
export type PlanStair = z.infer<typeof PlanStairSchema>;

export const PlanSiteSchema = z.looseObject({
  name: z.string().default("Site"),
  latitude_deg: z.number().min(-90).max(90).nullish(),
  longitude_deg: z.number().min(-180).max(180).nullish(),
  elevation_mm: z.number().default(0),
  true_north_deg: z.number().min(-360).max(360).default(0),
  timezone: z.string().nullish(),
  evidence: z.string().min(1),
});
export type PlanSite = z.infer<typeof PlanSiteSchema>;

export const PlanUnderlaySchema = z.looseObject({
  file_name: z.string().min(1),
  sha256: z.string().min(1),
  width_px: z.number().int().positive(),
  height_px: z.number().int().positive(),
  mm_per_px: z.number().positive(),
  origin_px: z.looseObject({ x: z.number(), y: z.number() }),
  rotation_deg: z.number().min(-360).max(360).default(0),
  opacity: z.number().min(0).max(1).default(0.55),
  calibration_note: z.string().nullish(),
  evidence: z.string().min(1),
});
export type PlanUnderlay = z.infer<typeof PlanUnderlaySchema>;

export const PlanDocumentSchema = z.looseObject({
  schema: z.string().min(1),
  project_id: z.string().min(1),
  building_name: z.string().min(1),
  declared_internal_area_m2: z.number().positive().nullish(),
  source: z.looseObject({
    file_name: z.string(),
    sha256: z.string(),
    page: z.number().int().min(1),
    locator: z.string(),
    method: z.string(),
  }),
  coordinate_frame: z.looseObject({
    units: z.string(),
    x_axis: z.string(),
    y_axis: z.string(),
    z_axis: z.string(),
    origin: z.string(),
    trace_transform: z.string(),
  }),
  evidence: z.record(z.string(), PlanEvidenceSchema),
  points: z.record(z.string(), PlanPointSchema),
  controls: z.array(PlanControlSchema),
  rooms: z.array(PlanRoomSchema),
  default_wall: z.looseObject({ thickness_mm: z.number().positive(), evidence: z.string() }),
  wall_overrides: z
    .array(
      z.looseObject({
        point_ids: z.tuple([z.string(), z.string()]),
        thickness_mm: z.number().positive().nullish(),
        base_elevation_mm: z.number().min(0).nullish(),
        // An open boundary rather than a partition: a room traced as a lower
        // level of another shares its outline, and a shared edge the level
        // change runs through is a void, not a wall.
        omit: z.boolean().default(false),
        evidence: z.string(),
      }),
    )
    .default([]),
  apertures: z.array(PlanApertureSchema).default([]),
  daylight_sources: z.array(PlanDaylightSourceSchema).default([]),
  stairs: z.array(PlanStairSchema).default([]),
  soffits: z.array(PlanSoffitSchema).default([]),
  site: PlanSiteSchema.nullish(),
  underlay: PlanUnderlaySchema.nullish(),
  review_notes: z.array(z.string()).default([]),
});
export type PlanDocument = z.infer<typeof PlanDocumentSchema>;

const PlanFindingSchema = z.object({ code: z.string(), message: z.string() });
export type PlanFinding = z.infer<typeof PlanFindingSchema>;

export const ControlCheckSchema = z.object({
  id: z.string(),
  expected_mm: z.number(),
  traced_mm: z.number(),
  discrepancy_mm: z.number(),
  tolerance_mm: z.number(),
  passed: z.boolean(),
});
export type ControlCheck = z.infer<typeof ControlCheckSchema>;

export const PlanReviewSchema = z.object({
  source_digest: z.string(),
  controls: z.array(ControlCheckSchema),
  blockers: z.array(PlanFindingSchema),
  warnings: z.array(PlanFindingSchema),
  room_count: z.number(),
  wall_count: z.number(),
  traced_net_area_m2: z.number(),
  declared_internal_area_m2: z.number().nullable(),
  review_notes: z.array(z.string()),
  aperture_count: z.number(),
  site_located: z.boolean(),
  has_underlay: z.boolean(),
});
export type PlanReview = z.infer<typeof PlanReviewSchema>;

export const TraceSchema = z.object({
  document: PlanDocumentSchema,
  review: PlanReviewSchema,
  revision: z.string(),
  source_path: z.string(),
  underlay_url: z.string().nullable(),
  draft: z.object({
    path: z.string(),
    exists: z.boolean(),
    revision: z.string().nullable(),
    is_open_model: z.boolean(),
  }),
});
export type Trace = z.infer<typeof TraceSchema>;

export const TraceReviewResponseSchema = z.object({ review: PlanReviewSchema });

export const TraceSaveResponseSchema = z.object({
  revision: z.string(),
  review: PlanReviewSchema,
  trace: TraceSchema,
});

export const DraftBuildReportSchema = z.object({
  path: z.string(),
  revision: z.string(),
  source_digest: z.string(),
  published: z.boolean(),
  rooms_verified: z.array(z.string()),
  controls: z.array(ControlCheckSchema),
  schema_issue_count: z.number(),
  warnings: z.array(PlanFindingSchema),
});
export type DraftBuildReport = z.infer<typeof DraftBuildReportSchema>;

export const TraceBuildResponseSchema = z.object({
  report: DraftBuildReportSchema,
  model_reloaded: z.boolean(),
  revision: z.string(),
  trace: TraceSchema,
});
export type TraceBuildResponse = z.infer<typeof TraceBuildResponseSchema>;

export const UnderlayUploadSchema = z.object({
  file_name: z.string(),
  sha256: z.string(),
  width_px: z.number(),
  height_px: z.number(),
  size_bytes: z.number(),
});
export type UnderlayUpload = z.infer<typeof UnderlayUploadSchema>;

export const SiteResponseSchema = z.object({ site: SiteSchema });

export type ViewMode = "plan" | "model";
export type PlanScope = "room" | "whole";
export type WorkspaceMode = "design" | "trace";
