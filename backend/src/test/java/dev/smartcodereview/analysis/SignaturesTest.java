package dev.smartcodereview.analysis;

import dev.smartcodereview.analysis.SymbolExtractor.Symbol;
import dev.smartcodereview.model.Model.Parameter;
import dev.smartcodereview.model.Model.Signature;
import dev.smartcodereview.model.Model.TypeField;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class SignaturesTest {

    @Test
    void readsTypeScriptMethodsFunctionsAndArrowFunctions() {
        String source = """
                export class PlayerApiService {
                  /** Sets the number. */
                  setJerseyNumber(id: string, jerseyNumber: number | null, options: { silent?: boolean } = {}): Observable<PlayerDetail> {
                    return this.http.put<PlayerDetail>(`/api/players/${id}`, { jerseyNumber });
                  }

                  private log(...parts: string[]): void {
                    console.log(parts);
                  }
                }

                export function byName(a: Player, b: Player): number {
                  return a.name.localeCompare(b.name);
                }

                export const toLabel = (player: Player, short = false): string => player.name;
                """;

        Signature set = signature(source, "player-api.service.ts", "setJerseyNumber");
        assertEquals(List.of(new Parameter("id", "string"), new Parameter("jerseyNumber", "number | null"),
                new Parameter("options", "{ silent?: boolean }")), set.params());
        assertEquals("Observable<PlayerDetail>", set.returns());
        assertEquals("setJerseyNumber(id: string, jerseyNumber: number | null, options: { silent?: boolean } = {}): Observable<PlayerDetail>",
                set.declaration());
        assertEquals(List.of("Observable", "PlayerDetail"), Signatures.typeNames(set));

        Signature log = signature(source, "player-api.service.ts", "log");
        assertEquals(List.of(new Parameter("...parts", "string[]")), log.params());
        assertEquals("void", log.returns());

        Signature byName = signature(source, "player-api.service.ts", "byName");
        assertEquals(List.of(new Parameter("a", "Player"), new Parameter("b", "Player")), byName.params());
        assertEquals("number", byName.returns());

        Signature toLabel = signature(source, "player-api.service.ts", "toLabel");
        assertEquals(List.of(new Parameter("player", "Player"), new Parameter("short", null)), toLabel.params());
        assertEquals("string", toLabel.returns());
    }

    @Test
    void readsJavaMethodsWithAnnotationsGenericsAndSeveralLines() {
        String source = """
                public class PlayerResource {

                    @PUT
                    @Path("/{playerId}")
                    @Transactional
                    public PlayerDetailDto update(@PathParam("playerId") UUID playerId,
                                                  @Valid final PlayerUpdateRequest request) {
                        return service.update(playerId, request);
                    }

                    private static Map<String, List<Player>> group(List<Player> items, String... keys) throws IOException {
                        return Map.of();
                    }

                    public PlayerResource(PlayerService service) {
                        this.service = service;
                    }
                }
                """;

        Signature update = signature(source, "PlayerResource.java", "update");
        assertEquals(List.of(new Parameter("playerId", "UUID"), new Parameter("request", "PlayerUpdateRequest")), update.params());
        assertEquals("PlayerDetailDto", update.returns());
        assertEquals("public PlayerDetailDto update(@PathParam(\"playerId\") UUID playerId, @Valid final PlayerUpdateRequest request)",
                update.declaration());

        Signature group = signature(source, "PlayerResource.java", "group");
        assertEquals(List.of(new Parameter("items", "List<Player>"), new Parameter("keys", "String...")), group.params());
        assertEquals("Map<String, List<Player>>", group.returns());
        assertEquals("private static Map<String, List<Player>> group(List<Player> items, String... keys) throws IOException",
                group.declaration());

        Signature constructor = signature(source, "PlayerResource.java", "PlayerResource");
        if (constructor != null) { // constructors are methods without a return type, where they are symbols at all
            assertNull(constructor.returns());
        }
    }

    @Test
    void readsKotlinGoAndCSharp() {
        String kotlin = """
                class PlayerService(private val repo: PlayerRepository) {
                    fun rename(id: UUID, name: String = "?"): Player? {
                        return repo.find(id)
                    }

                }
                """;
        Signature rename = signature(kotlin, "PlayerService.kt", "rename");
        assertEquals(List.of(new Parameter("id", "UUID"), new Parameter("name", "String")), rename.params());
        assertEquals("Player?", rename.returns());

        String go = """
                package players

                func (s *Service) Update(ctx context.Context, id, name string) (*Player, error) {
                	return nil, nil
                }
                """;
        Signature update = signature(go, "service.go", "Update");
        assertEquals(List.of(new Parameter("ctx", "context.Context"), new Parameter("id", "string"), new Parameter("name", "string")),
                update.params());
        assertEquals("(*Player, error)", update.returns());

        String csharp = """
                public class PlayerController {
                    public async Task<ActionResult<PlayerDto>> Update([FromRoute] Guid id, [FromBody] PlayerUpdate request) {
                        return Ok();
                    }
                }
                """;
        Signature controller = signature(csharp, "PlayerController.cs", "Update");
        assertEquals("Task<ActionResult<PlayerDto>>", controller.returns());
        assertEquals(List.of("id", "request"), controller.params().stream().map(Parameter::name).toList());
    }

    @Test
    void namesTheTypesOfASignatureAlsoWhenTheyAreQualified() {
        String source = """
                public class ReviewService {
                    public Optional<Model.PrStatus> status(PrRef ref, java.util.List<Map.Entry<String, Comment>> notes) {
                        return Optional.empty();
                    }
                }
                """;

        assertEquals(List.of("PrRef", "List", "Entry", "String", "Comment", "Optional", "PrStatus"),
                Signatures.typeNames(signature(source, "ReviewService.java", "status")));
    }

    @Test
    void doesNotTakeACallInTheBodyForTheDeclaration() {
        String source = """
                export class Cache {
                  refresh = () => {
                    this.load(this.key, true);
                  };

                  load(key: string, force: boolean): void {
                    this.refresh();
                  }
                }
                """;

        assertEquals(List.of(), signature(source, "cache.ts", "refresh").params());
        assertEquals(List.of(new Parameter("key", "string"), new Parameter("force", "boolean")), signature(source, "cache.ts", "load").params());
    }

    @Test
    void listsTheFieldsOfTypesWithoutTheirMethods() {
        String ts = """
                export interface PlayerDetail {
                  id: string;
                  name: string;
                  jerseyNumber?: number | null;
                  team: {
                    id: string;
                  };
                  rename(name: string): void;
                }

                export type Role = 'coach' | 'player';

                export enum Position {
                  Goalie = 'goalie',
                  Defender = 'defender',
                }

                export class PlayerView {
                  readonly player = input.required<PlayerDetail>();
                  protected editing = false;
                  private readonly api: PlayerApiService = inject(PlayerApiService);

                  save(): void {
                    const local: string = 'x';
                  }
                }
                """;
        assertEquals(List.of(new TypeField("id", "string"), new TypeField("name", "string"),
                new TypeField("jerseyNumber?", "number | null"), new TypeField("team", "{…}")), fields(ts, "player.model.ts", "PlayerDetail"));
        assertEquals(List.of(), fields(ts, "player.model.ts", "Role"));
        assertEquals(List.of(new TypeField("Goalie", null), new TypeField("Defender", null)), fields(ts, "player.model.ts", "Position"));
        assertEquals(List.of(new TypeField("player", null), new TypeField("editing", null), new TypeField("api", "PlayerApiService")),
                fields(ts, "player.model.ts", "PlayerView"));
    }

    @Test
    void listsFieldsOfJavaKotlinAndGoTypes() {
        String java = """
                @Entity
                @Table(name = "player", indexes = {@Index(columnList = "team_id")})
                public class Player {
                    @Id
                    private UUID id;
                    @Column(nullable = false) private String name;
                    private Integer jerseyNumber = null;
                    private final List<Game> games = new ArrayList<>();

                    public boolean isJerseyNumberTaken(int number) {
                        return false;
                    }
                }

                record PlayerUpdateRequest(String name, @Min(1) Integer jerseyNumber) {
                }

                enum Status {
                    ACTIVE("a"), INJURED("i");

                    private final String code;
                }
                """;
        assertEquals(List.of(new TypeField("id", "UUID"), new TypeField("name", "String"), new TypeField("jerseyNumber", "Integer"),
                new TypeField("games", "List<Game>")), fields(java, "Player.java", "Player"));
        assertEquals(List.of(new TypeField("name", "String"), new TypeField("jerseyNumber", "Integer")),
                fields(java, "Player.java", "PlayerUpdateRequest"));

        String kotlin = """
                data class PlayerDto(val id: UUID, val name: String, var jerseyNumber: Int? = null) {
                    val label: String = name
                }
                """;
        assertEquals(List.of(new TypeField("id", "UUID"), new TypeField("name", "String"), new TypeField("jerseyNumber", "Int?"),
                new TypeField("label", "String")), fields(kotlin, "PlayerDto.kt", "PlayerDto"));

        String go = """
                package players

                type Player struct {
                	ID   string `json:"id"`
                	Name string
                	Tags []string `json:"tags"`
                }
                """;
        assertEquals(List.of(new TypeField("ID", "string"), new TypeField("Name", "string"), new TypeField("Tags", "[]string")),
                fields(go, "player.go", "Player"));
    }

    private static Signature signature(String source, String path, String name) {
        CodeText text = CodeText.of(source);
        Symbol symbol = SymbolExtractor.extract(text, path).stream()
                .filter(s -> s.name().equals(name) && !s.kind().equals("class")).findFirst().orElse(null);
        return symbol == null ? null : Signatures.of(text, symbol, Languages.of(path));
    }

    private static List<TypeField> fields(String source, String path, String name) {
        CodeText text = CodeText.of(source);
        Symbol symbol = SymbolExtractor.extract(text, path).stream().filter(s -> s.name().equals(name)).findFirst().orElseThrow();
        return Signatures.fieldsOf(text, symbol, Languages.of(path));
    }
}
