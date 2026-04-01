(module
  (memory (export "memory") 24)

  (func (export "analyze_polygon") (param $ptr i32) (param $loops i32) (param $vertices_per_loop i32) (param $result_ptr i32)
    (local $loop i32)
    (local $vertex i32)
    (local $base i32)
    (local $offset i32)
    (local $next i32)
    (local $next_offset i32)
    (local $x1 f32)
    (local $y1 f32)
    (local $x2 f32)
    (local $y2 f32)
    (local $area f32)
    (local $total_area f32)
    (local $min_x f32)
    (local $min_y f32)
    (local $max_x f32)
    (local $max_y f32)

    f32.const 0
    local.set $total_area

    f32.const 1000000000
    local.set $min_x
    f32.const 1000000000
    local.set $min_y
    f32.const -1000000000
    local.set $max_x
    f32.const -1000000000
    local.set $max_y

    i32.const 0
    local.set $loop

    (block $outer_done
      (loop $outer
        local.get $loop
        local.get $loops
        i32.ge_u
        br_if $outer_done

        local.get $ptr
        local.get $loop
        local.get $vertices_per_loop
        i32.mul
        i32.const 8
        i32.mul
        i32.add
        local.set $base

        f32.const 0
        local.set $area

        i32.const 0
        local.set $vertex

        (block $inner_done
          (loop $inner
            local.get $vertex
            local.get $vertices_per_loop
            i32.ge_u
            br_if $inner_done

            local.get $base
            local.get $vertex
            i32.const 8
            i32.mul
            i32.add
            local.set $offset

            local.get $vertex
            i32.const 1
            i32.add
            local.get $vertices_per_loop
            i32.rem_u
            local.set $next

            local.get $base
            local.get $next
            i32.const 8
            i32.mul
            i32.add
            local.set $next_offset

            local.get $offset
            f32.load
            local.set $x1

            local.get $offset
            i32.const 4
            i32.add
            f32.load
            local.set $y1

            local.get $next_offset
            f32.load
            local.set $x2

            local.get $next_offset
            i32.const 4
            i32.add
            f32.load
            local.set $y2

            local.get $area
            local.get $x1
            local.get $y2
            f32.mul
            local.get $x2
            local.get $y1
            f32.mul
            f32.sub
            f32.add
            local.set $area

            local.get $x1
            local.get $min_x
            f32.min
            local.set $min_x

            local.get $y1
            local.get $min_y
            f32.min
            local.set $min_y

            local.get $x1
            local.get $max_x
            f32.max
            local.set $max_x

            local.get $y1
            local.get $max_y
            f32.max
            local.set $max_y

            local.get $vertex
            i32.const 1
            i32.add
            local.set $vertex

            br $inner
          )
        )

        local.get $total_area
        local.get $area
        f32.abs
        f32.const 0.5
        f32.mul
        f32.add
        local.set $total_area

        local.get $loop
        i32.const 1
        i32.add
        local.set $loop

        br $outer
      )
    )

    local.get $result_ptr
    local.get $total_area
    f32.store

    local.get $result_ptr
    i32.const 4
    i32.add
    local.get $min_x
    f32.store

    local.get $result_ptr
    i32.const 8
    i32.add
    local.get $min_y
    f32.store

    local.get $result_ptr
    i32.const 12
    i32.add
    local.get $max_x
    f32.store

    local.get $result_ptr
    i32.const 16
    i32.add
    local.get $max_y
    f32.store
  )

  (func (export "analyze_heightfield") (param $ptr i32) (param $count i32) (param $result_ptr i32)
    (local $index i32)
    (local $offset i32)
    (local $value f32)
    (local $min_value f32)
    (local $max_value f32)
    (local $sum f32)

    f32.const 1000000000
    local.set $min_value
    f32.const -1000000000
    local.set $max_value
    f32.const 0
    local.set $sum
    i32.const 0
    local.set $index

    (block $done
      (loop $loop
        local.get $index
        local.get $count
        i32.ge_u
        br_if $done

        local.get $ptr
        local.get $index
        i32.const 4
        i32.mul
        i32.add
        local.set $offset

        local.get $offset
        f32.load
        local.set $value

        local.get $value
        local.get $min_value
        f32.min
        local.set $min_value

        local.get $value
        local.get $max_value
        f32.max
        local.set $max_value

        local.get $sum
        local.get $value
        f32.add
        local.set $sum

        local.get $index
        i32.const 1
        i32.add
        local.set $index

        br $loop
      )
    )

    local.get $result_ptr
    local.get $min_value
    f32.store

    local.get $result_ptr
    i32.const 4
    i32.add
    local.get $max_value
    f32.store

    local.get $result_ptr
    i32.const 8
    i32.add
    local.get $sum
    local.get $count
    f32.convert_i32_u
    f32.div
    f32.store

    local.get $result_ptr
    i32.const 12
    i32.add
    local.get $sum
    f32.store
  )

  (func (export "quantize_unit_f32") (param $ptr i32) (param $count i32) (param $out_ptr i32) (param $result_ptr i32)
    (local $index i32)
    (local $offset i32)
    (local $out_offset i32)
    (local $value f32)
    (local $scaled f32)
    (local $min_value f32)
    (local $max_value f32)
    (local $sum f32)
    (local $checksum f32)
    (local $quantized i32)

    f32.const 1000000000
    local.set $min_value
    f32.const -1000000000
    local.set $max_value
    f32.const 0
    local.set $sum
    f32.const 0
    local.set $checksum
    i32.const 0
    local.set $index

    (block $done
      (loop $loop
        local.get $index
        local.get $count
        i32.ge_u
        br_if $done

        local.get $ptr
        local.get $index
        i32.const 4
        i32.mul
        i32.add
        local.set $offset

        local.get $offset
        f32.load
        local.set $value

        local.get $value
        local.get $min_value
        f32.min
        local.set $min_value

        local.get $value
        local.get $max_value
        f32.max
        local.set $max_value

        local.get $sum
        local.get $value
        f32.add
        local.set $sum

        local.get $value
        f32.const 0
        f32.max
        f32.const 1
        f32.min
        f32.const 255
        f32.mul
        local.set $scaled

        local.get $scaled
        i32.trunc_f32_u
        local.set $quantized

        local.get $out_ptr
        local.get $index
        i32.add
        local.set $out_offset

        local.get $out_offset
        local.get $quantized
        i32.store8

        local.get $checksum
        local.get $quantized
        f32.convert_i32_u
        f32.add
        local.set $checksum

        local.get $index
        i32.const 1
        i32.add
        local.set $index

        br $loop
      )
    )

    local.get $result_ptr
    local.get $min_value
    f32.store

    local.get $result_ptr
    i32.const 4
    i32.add
    local.get $max_value
    f32.store

    local.get $result_ptr
    i32.const 8
    i32.add
    local.get $sum
    local.get $count
    f32.convert_i32_u
    f32.div
    f32.store

    local.get $result_ptr
    i32.const 12
    i32.add
    local.get $checksum
    f32.store
  )

  (func (export "build_heightfield_mesh")
    (param $ptr i32)
    (param $width i32)
    (param $height i32)
    (param $position_ptr i32)
    (param $index_ptr i32)
    (param $result_ptr i32)
    (local $x i32)
    (local $y i32)
    (local $index i32)
    (local $offset i32)
    (local $vertex_offset i32)
    (local $cell_offset i32)
    (local $a i32)
    (local $b i32)
    (local $c i32)
    (local $d i32)
    (local $vertex_count i32)
    (local $triangle_count i32)
    (local $value f32)
    (local $fx f32)
    (local $fy f32)
    (local $min_value f32)
    (local $max_value f32)
    (local $sum f32)
    (local $h00 f32)
    (local $h10 f32)
    (local $h01 f32)
    (local $h11 f32)
    (local $diag0 f32)
    (local $diag1 f32)

    local.get $width
    local.get $height
    i32.mul
    local.set $vertex_count

    local.get $width
    i32.const 1
    i32.sub
    local.get $height
    i32.const 1
    i32.sub
    i32.mul
    i32.const 2
    i32.mul
    local.set $triangle_count

    f32.const 1000000000
    local.set $min_value
    f32.const -1000000000
    local.set $max_value
    f32.const 0
    local.set $sum

    i32.const 0
    local.set $y

    (block $vertex_rows_done
      (loop $vertex_rows
        local.get $y
        local.get $height
        i32.ge_u
        br_if $vertex_rows_done

        i32.const 0
        local.set $x

        (block $vertex_cols_done
          (loop $vertex_cols
            local.get $x
            local.get $width
            i32.ge_u
            br_if $vertex_cols_done

            local.get $x
            local.get $y
            local.get $width
            i32.mul
            i32.add
            local.set $index

            local.get $ptr
            local.get $index
            i32.const 4
            i32.mul
            i32.add
            local.set $offset

            local.get $offset
            f32.load
            local.set $value

            local.get $value
            local.get $min_value
            f32.min
            local.set $min_value

            local.get $value
            local.get $max_value
            f32.max
            local.set $max_value

            local.get $sum
            local.get $value
            f32.add
            local.set $sum

            local.get $position_ptr
            local.get $index
            i32.const 12
            i32.mul
            i32.add
            local.set $vertex_offset

            local.get $x
            f32.convert_i32_u
            local.get $width
            i32.const 1
            i32.sub
            f32.convert_i32_u
            f32.div
            local.set $fx

            local.get $y
            f32.convert_i32_u
            local.get $height
            i32.const 1
            i32.sub
            f32.convert_i32_u
            f32.div
            local.set $fy

            local.get $vertex_offset
            local.get $fx
            f32.const 8.4
            f32.mul
            f32.const 4.2
            f32.sub
            f32.store

            local.get $vertex_offset
            i32.const 4
            i32.add
            local.get $value
            f32.const 2.6
            f32.mul
            f32.store

            local.get $vertex_offset
            i32.const 8
            i32.add
            local.get $fy
            f32.const 6.4
            f32.mul
            f32.const 3.2
            f32.sub
            f32.store

            local.get $x
            i32.const 1
            i32.add
            local.set $x

            br $vertex_cols
          )
        )

        local.get $y
        i32.const 1
        i32.add
        local.set $y

        br $vertex_rows
      )
    )

    i32.const 0
    local.set $y

    (block $cell_rows_done
      (loop $cell_rows
        local.get $y
        local.get $height
        i32.const 1
        i32.sub
        i32.ge_u
        br_if $cell_rows_done

        i32.const 0
        local.set $x

        (block $cell_cols_done
          (loop $cell_cols
            local.get $x
            local.get $width
            i32.const 1
            i32.sub
            i32.ge_u
            br_if $cell_cols_done

            local.get $x
            local.get $y
            local.get $width
            i32.mul
            i32.add
            local.set $a

            local.get $a
            i32.const 1
            i32.add
            local.set $b

            local.get $a
            local.get $width
            i32.add
            local.set $c

            local.get $c
            i32.const 1
            i32.add
            local.set $d

            local.get $ptr
            local.get $a
            i32.const 4
            i32.mul
            i32.add
            f32.load
            local.set $h00

            local.get $ptr
            local.get $b
            i32.const 4
            i32.mul
            i32.add
            f32.load
            local.set $h10

            local.get $ptr
            local.get $c
            i32.const 4
            i32.mul
            i32.add
            f32.load
            local.set $h01

            local.get $ptr
            local.get $d
            i32.const 4
            i32.mul
            i32.add
            f32.load
            local.set $h11

            local.get $h00
            local.get $h11
            f32.sub
            f32.abs
            local.set $diag0

            local.get $h10
            local.get $h01
            f32.sub
            f32.abs
            local.set $diag1

            local.get $index_ptr
            local.get $x
            local.get $y
            local.get $width
            i32.const 1
            i32.sub
            i32.mul
            i32.add
            i32.const 24
            i32.mul
            i32.add
            local.set $cell_offset

            local.get $diag0
            local.get $diag1
            f32.le
            if
              local.get $cell_offset
              local.get $a
              i32.store

              local.get $cell_offset
              i32.const 4
              i32.add
              local.get $b
              i32.store

              local.get $cell_offset
              i32.const 8
              i32.add
              local.get $d
              i32.store

              local.get $cell_offset
              i32.const 12
              i32.add
              local.get $a
              i32.store

              local.get $cell_offset
              i32.const 16
              i32.add
              local.get $d
              i32.store

              local.get $cell_offset
              i32.const 20
              i32.add
              local.get $c
              i32.store
            else
              local.get $cell_offset
              local.get $a
              i32.store

              local.get $cell_offset
              i32.const 4
              i32.add
              local.get $b
              i32.store

              local.get $cell_offset
              i32.const 8
              i32.add
              local.get $c
              i32.store

              local.get $cell_offset
              i32.const 12
              i32.add
              local.get $b
              i32.store

              local.get $cell_offset
              i32.const 16
              i32.add
              local.get $d
              i32.store

              local.get $cell_offset
              i32.const 20
              i32.add
              local.get $c
              i32.store
            end

            local.get $x
            i32.const 1
            i32.add
            local.set $x

            br $cell_cols
          )
        )

        local.get $y
        i32.const 1
        i32.add
        local.set $y

        br $cell_rows
      )
    )

    local.get $result_ptr
    local.get $vertex_count
    f32.convert_i32_u
    f32.store

    local.get $result_ptr
    i32.const 4
    i32.add
    local.get $triangle_count
    f32.convert_i32_u
    f32.store

    local.get $result_ptr
    i32.const 8
    i32.add
    local.get $min_value
    f32.store

    local.get $result_ptr
    i32.const 12
    i32.add
    local.get $max_value
    f32.store

    local.get $result_ptr
    i32.const 16
    i32.add
    local.get $sum
    local.get $vertex_count
    f32.convert_i32_u
    f32.div
    f32.store

    local.get $result_ptr
    i32.const 20
    i32.add
    local.get $sum
    f32.store
  )

  (func (export "step_rotation") (param $angle f32) (param $delta f32) (param $speed f32) (result f32)
    (local $next f32)

    local.get $angle
    local.get $delta
    local.get $speed
    f32.mul
    f32.add
    local.set $next

    local.get $next
    f32.const 6.2831855
    f32.ge
    if (result f32)
      local.get $next
      f32.const 6.2831855
      f32.sub
    else
      local.get $next
    end
  )

  (func $update_swarm (export "update_swarm")
    (param $state_ptr i32)
    (param $count i32)
    (param $output_ptr i32)
    (param $delta f32)
    (param $time f32)
    (param $substeps i32)
    (local $index i32)
    (local $step i32)
    (local $state_offset i32)
    (local $output_offset i32)
    (local $sub_delta f32)
    (local $home_x f32)
    (local $home_y f32)
    (local $home_z f32)
    (local $pos_x f32)
    (local $pos_y f32)
    (local $pos_z f32)
    (local $vel_x f32)
    (local $vel_y f32)
    (local $vel_z f32)
    (local $phase f32)
    (local $dx f32)
    (local $dy f32)
    (local $dz f32)
    (local $swirl_x f32)
    (local $swirl_z f32)
    (local $pulse f32)
    (local $lift f32)

    local.get $substeps
    i32.const 1
    i32.lt_s
    if
      i32.const 1
      local.set $substeps
    end

    local.get $delta
    local.get $substeps
    f32.convert_i32_s
    f32.div
    local.set $sub_delta

    i32.const 0
    local.set $index

    (block $outer_done
      (loop $outer
        local.get $index
        local.get $count
        i32.ge_u
        br_if $outer_done

        local.get $state_ptr
        local.get $index
        i32.const 40
        i32.mul
        i32.add
        local.set $state_offset

        local.get $state_offset
        f32.load
        local.set $home_x
        local.get $state_offset
        i32.const 4
        i32.add
        f32.load
        local.set $home_y
        local.get $state_offset
        i32.const 8
        i32.add
        f32.load
        local.set $home_z
        local.get $state_offset
        i32.const 12
        i32.add
        f32.load
        local.set $pos_x
        local.get $state_offset
        i32.const 16
        i32.add
        f32.load
        local.set $pos_y
        local.get $state_offset
        i32.const 20
        i32.add
        f32.load
        local.set $pos_z
        local.get $state_offset
        i32.const 24
        i32.add
        f32.load
        local.set $vel_x
        local.get $state_offset
        i32.const 28
        i32.add
        f32.load
        local.set $vel_y
        local.get $state_offset
        i32.const 32
        i32.add
        f32.load
        local.set $vel_z
        local.get $state_offset
        i32.const 36
        i32.add
        f32.load
        local.set $phase

        i32.const 0
        local.set $step

        (block $step_done
          (loop $step_loop
            local.get $step
            local.get $substeps
            i32.ge_u
            br_if $step_done

            local.get $phase
            local.get $sub_delta
            f32.const 0.55
            local.get $home_y
            f32.const 0.015
            f32.mul
            f32.add
            f32.mul
            f32.add
            local.set $phase

            local.get $phase
            f32.const 1
            f32.ge
            if
              local.get $phase
              f32.const 1
              f32.sub
              local.set $phase
            end

            local.get $phase
            f32.const 0.5
            f32.lt
            if
              local.get $phase
              f32.const 2
              f32.mul
              local.set $pulse
            else
              f32.const 1
              local.get $phase
              f32.sub
              f32.const 2
              f32.mul
              local.set $pulse
            end

            local.get $home_x
            local.get $pos_x
            f32.sub
            local.set $dx
            local.get $home_y
            local.get $pos_y
            f32.sub
            local.set $dy
            local.get $home_z
            local.get $pos_z
            f32.sub
            local.set $dz

            local.get $dz
            f32.neg
            f32.const 0.48
            f32.mul
            local.set $swirl_x
            local.get $dx
            f32.const 0.48
            f32.mul
            local.set $swirl_z

            local.get $pulse
            f32.const 0.5
            f32.sub
            f32.const 0.55
            f32.mul
            local.get $time
            local.get $home_x
            f32.const 0.12
            f32.mul
            f32.add
            local.get $home_z
            f32.const 0.08
            f32.mul
            f32.add
            f32.const 0.25
            f32.mul
            f32.add
            local.set $lift

            local.get $vel_x
            f32.const 0.94
            f32.mul
            local.get $dx
            f32.const 0.68
            local.get $sub_delta
            f32.mul
            f32.mul
            f32.add
            local.get $swirl_x
            f32.const 0.42
            local.get $sub_delta
            f32.mul
            f32.mul
            f32.add
            local.get $home_y
            f32.const 0.3
            f32.add
            f32.const 0.015
            local.get $sub_delta
            f32.mul
            f32.mul
            f32.add
            local.set $vel_x

            local.get $vel_y
            f32.const 0.92
            f32.mul
            local.get $dy
            f32.const 0.62
            local.get $sub_delta
            f32.mul
            f32.mul
            f32.add
            local.get $lift
            f32.const 0.38
            local.get $sub_delta
            f32.mul
            f32.mul
            f32.add
            local.set $vel_y

            local.get $vel_z
            f32.const 0.94
            f32.mul
            local.get $dz
            f32.const 0.68
            local.get $sub_delta
            f32.mul
            f32.mul
            f32.add
            local.get $swirl_z
            f32.const 0.42
            local.get $sub_delta
            f32.mul
            f32.mul
            f32.add
            local.get $home_x
            local.get $home_z
            f32.sub
            f32.const 0.01
            local.get $sub_delta
            f32.mul
            f32.mul
            f32.sub
            local.set $vel_z

            local.get $pos_x
            local.get $vel_x
            local.get $sub_delta
            f32.mul
            f32.add
            local.set $pos_x
            local.get $pos_y
            local.get $vel_y
            local.get $sub_delta
            f32.mul
            f32.add
            local.set $pos_y
            local.get $pos_z
            local.get $vel_z
            local.get $sub_delta
            f32.mul
            f32.add
            local.set $pos_z

            local.get $step
            i32.const 1
            i32.add
            local.set $step
            br $step_loop
          )
        )

        local.get $state_offset
        i32.const 12
        i32.add
        local.get $pos_x
        f32.store
        local.get $state_offset
        i32.const 16
        i32.add
        local.get $pos_y
        f32.store
        local.get $state_offset
        i32.const 20
        i32.add
        local.get $pos_z
        f32.store
        local.get $state_offset
        i32.const 24
        i32.add
        local.get $vel_x
        f32.store
        local.get $state_offset
        i32.const 28
        i32.add
        local.get $vel_y
        f32.store
        local.get $state_offset
        i32.const 32
        i32.add
        local.get $vel_z
        f32.store
        local.get $state_offset
        i32.const 36
        i32.add
        local.get $phase
        f32.store

        local.get $output_ptr
        local.get $index
        i32.const 12
        i32.mul
        i32.add
        local.set $output_offset

        local.get $output_offset
        local.get $pos_x
        f32.store
        local.get $output_offset
        i32.const 4
        i32.add
        local.get $pos_y
        f32.store
        local.get $output_offset
        i32.const 8
        i32.add
        local.get $pos_z
        f32.store

        local.get $index
        i32.const 1
        i32.add
        local.set $index
        br $outer
      )
    )
  )

  (func (export "simulate_swarm_frames")
    (param $state_ptr i32)
    (param $count i32)
    (param $output_ptr i32)
    (param $delta f32)
    (param $start_time f32)
    (param $substeps i32)
    (param $frames i32)
    (local $frame i32)
    (local $time f32)

    local.get $start_time
    local.set $time

    i32.const 0
    local.set $frame

    (block $done
      (loop $loop
        local.get $frame
        local.get $frames
        i32.ge_s
        br_if $done

        local.get $time
        local.get $delta
        f32.add
        local.set $time

        local.get $state_ptr
        local.get $count
        local.get $output_ptr
        local.get $delta
        local.get $time
        local.get $substeps
        call $update_swarm

        local.get $frame
        i32.const 1
        i32.add
        local.set $frame

        br $loop
      )
    )
  )
)
